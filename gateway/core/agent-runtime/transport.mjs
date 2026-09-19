import crypto from "node:crypto";
import path from "node:path";

import { ApiError, invariant, redactSensitive } from "../errors.mjs";
import {
  assertEasyWorkSkillPaths,
  assertRuntimeIdentifier,
  createRuntimeRunId,
  remoteAgentPaths,
  runtimeAgentDefinition,
  runtimeEnvironment,
  unsupportedCapability,
} from "./contract.mjs";
import {
  INTERNAL_VERSION_HOOK_STATUS,
  VERSION_HOOK_REVISION,
  VERSION_PRETOOL_LAUNCHER,
  VERSION_PRETOOL_PYTHON,
  versionHookCheckCommand,
  versionHookCommand,
  versionHookPaths,
} from "./version-pretool.mjs";
import { AsyncQueue } from "./ssh-executor.mjs";
import { normalizeNativeSkillFiles, parseNativeSkill } from "../skills/native-package.mjs";
import { captureSkillSnapshot, restoreSkillSnapshot, readSkillView, selectedSkillCommand } from "./skill-views.mjs";

const DEFAULT_OPENCODE_OUTPUT_LIMIT = 32_768;
const PREPARED_RUNTIME_TTL_MS = 15 * 60_000;
const SERVICE_HEALTH_TTL_MS = 60_000;
const READINESS_RPC_TIMEOUT_MS = 60_000;
// OpenCode builds its provider/model catalog lazily.  On shared HPC homes the
// first catalogue load can take well over a minute even though the service is
// healthy; scnet-gpu 1.18.30 was observed publishing the configured model at
// roughly 91 seconds.  Keep the process alive long enough for that native
// startup path while retaining the short per-request timeout below.
const OPENCODE_READY_TIMEOUT_MS = 120_000;
const OPENCODE_READY_REQUEST_TIMEOUT_MS = 3_000;
const OPENCODE_NATIVE_STORE_CLONE_REVISION = 4;
const CODEX_STORAGE_PROBE_MARKER = "__EASYWORK_CODEX_STORAGE__";
async function confirmProcessExit(process, timeoutMs) {
  if (process.closed) return true;
  invariant(typeof process.wait === "function", "AGENT_INTERRUPT_UNCONFIRMED", "无法确认远端进程是否已停止", { status: 502, retryable: true });
  let timer;
  try {
    return await Promise.race([
      process.wait().then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
const OPENCODE_NATIVE_STORE_CLONE_SHELL = `#!/bin/sh
set -eu

source_dir=$1
target_dir=$2
root_dir=$3

[ "$source_dir" != "$target_dir" ] || exit 73
case "$source_dir/" in "$root_dir/"*) ;; *) exit 73 ;; esac
case "$target_dir/" in "$root_dir/"*) ;; *) exit 73 ;; esac
[ -d "$source_dir" ] || exit 74
[ ! -L "$source_dir" ] || exit 73
[ ! -L "$target_dir" ] || exit 73
source_app="$source_dir/opencode"
target_app="$target_dir/opencode"
[ -d "$source_app" ] || exit 74
[ ! -L "$source_app" ] || exit 73
[ ! -L "$target_app" ] || exit 73
mkdir -p -- "$target_app"

copied=0
for database in "$source_app"/opencode*.db; do
  [ -f "$database" ] || continue
  name=\${database##*/}
  cp -a -- "$database" "$target_app/$name"
  for suffix in -wal -shm -journal; do
    [ ! -f "$database$suffix" ] || cp -a -- "$database$suffix" "$target_app/$name$suffix"
  done
  copied=1
done

# OpenCode versions before the SQLite migration used the JSON storage tree.
if [ "$copied" -eq 0 ] && [ -d "$source_app/storage" ]; then
  cp -a -- "$source_app/storage" "$target_app/"
  copied=1
fi
[ "$copied" -eq 1 ] || exit 74

for metadata in auth.json mcp-auth.json; do
  [ ! -f "$source_app/$metadata" ] || cp -a -- "$source_app/$metadata" "$target_app/$metadata"
done
`;
// Codex 0.149.1's generated protocol/schema documents use `pre_tool_use`,
// while the released 0.149.1 app-server returns `preToolUse` from hooks/list.
// Accept only those two known wire representations and keep every other Hook
// field under exact validation.
const CODEX_PRE_TOOL_USE_EVENT_NAMES = new Set(["preToolUse", "pre_tool_use"]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

// Qoder scopes local transcripts by the real working-directory path. This is
// the exact key algorithm published by @qoder-ai/qoder-agent-sdk 1.0.41 and
// used by Qoder CN CLI 1.1.53. Keep it here instead of guessing from the
// directory names because long workspace paths carry a native DJB2 suffix.
function qoderProjectKey(value) {
  const source = String(value || "");
  const sanitized = source.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) hash = (hash * 33) ^ source.charCodeAt(index);
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function frameFromLine(line, { sse = false } = {}) {
  let text = String(line || "").trim();
  if (!text || text.startsWith(":")) return null;
  if (sse) {
    if (!text.startsWith("data:")) return null;
    text = text.slice(5).trim();
    if (!text || text === "[DONE]") return null;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function* parsedFrames(lines, options = {}) {
  for await (const line of lines) {
    const frame = frameFromLine(line, options);
    if (frame) yield frame;
  }
}

async function* prefixedFrames(frames, prefix = []) {
  for (const frame of Array.isArray(prefix) ? prefix : []) yield frame;
  for await (const frame of frames) yield frame;
}

const CLAUDE_NATIVE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function transcriptLocatorScript(projectsRoot, sessionId) {
  return [
    `projects_root=${shellQuote(projectsRoot)}`,
    `session_id=${shellQuote(sessionId)}`,
    "transcript=''",
    "fallback_transcript=''",
    "for candidate in \"$projects_root\"/*/\"$session_id.jsonl\"; do",
    "  [ -f \"$candidate\" ] || continue",
    "  if [ ! -L \"$candidate\" ]; then transcript=\"$candidate\"; break; fi",
    "  [ -n \"$fallback_transcript\" ] || fallback_transcript=\"$candidate\"",
    "done",
    "[ -n \"$transcript\" ] || transcript=\"$fallback_transcript\"",
  ];
}

function transcriptLeafCommand(configDirectory) {
  if (configDirectory === "qoder-cn") {
    // Qoder CLI 1.1.53 writes the selected transcript leaf as a standalone
    // `active-leaf` record. Its `last-prompt` record contains only lastPrompt
    // and sessionId, so treating it like Claude produces an empty boundary.
    return "tail -n 256 -- \"$transcript\" 2>/dev/null | grep -F '\"type\":\"active-leaf\"' | tail -n 1 | sed -n 's/.*\"leafUuid\":\"\\([^\"]*\\)\".*/\\1/p'";
  }
  return "tail -n 32 -- \"$transcript\" 2>/dev/null | grep -F '\"type\":\"last-prompt\"' | tail -n 1 | sed -n 's/.*\"leafUuid\":\"\\([^\"]*\\)\".*/\\1/p'";
}

async function nativeTranscriptHasAssistantBoundary({ executor, runtimeData, sessionId, turnId, configDirectory = "claude" }) {
  const normalizedSessionId = String(sessionId || "");
  const normalizedTurnId = String(turnId || "");
  if (!CLAUDE_NATIVE_UUID.test(normalizedSessionId)
    || !CLAUDE_NATIVE_UUID.test(normalizedTurnId)
    || !String(runtimeData || "")) return false;
  const projectsRoot = `${String(runtimeData)}/${String(configDirectory)}/projects`;
  const script = [
    ...transcriptLocatorScript(projectsRoot, normalizedSessionId),
    `turn_id=${shellQuote(normalizedTurnId)}`,
    "# easywork_boundary_check",
    "[ -n \"$transcript\" ] || exit 74",
    "grep -F \"\\\"uuid\\\":\\\"$turn_id\\\"\" \"$transcript\" 2>/dev/null | grep -Fq '\"type\":\"assistant\"'",
  ].join("\n");
  const result = await executor.exec(`sh -c ${shellQuote(script)}`, { maxOutputBytes: 512 }).catch(() => null);
  return Boolean(result && result.code === 0);
}

async function claudeTranscriptCurrentLeafUuid({ executor, runtimeData, sessionId, configDirectory = "claude" }) {
  const normalizedSessionId = String(sessionId || "");
  if (!CLAUDE_NATIVE_UUID.test(normalizedSessionId) || !String(runtimeData || "")) return null;
  const projectsRoot = `${String(runtimeData)}/${String(configDirectory)}/projects`;
  const script = [
    ...transcriptLocatorScript(projectsRoot, normalizedSessionId),
    "leaf=''",
    `if [ -n "$transcript" ]; then leaf="$(${transcriptLeafCommand(configDirectory)})"; fi`,
    "if [ -n \"$leaf\" ] && grep -F \"\\\"uuid\\\":\\\"$leaf\\\"\" \"$transcript\" 2>/dev/null | grep -Fq '\"type\":\"assistant\"'; then printf '%s\\n' \"$leaf\"; fi",
  ].join("\n");
  const result = await executor.exec(`sh -c ${shellQuote(script)}`, { maxOutputBytes: 512 }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const leafUuid = String(result.stdout || "").trim().split(/\s+/)[0] || "";
  return CLAUDE_NATIVE_UUID.test(leafUuid) ? leafUuid : null;
}

async function claudeTranscriptLeafUuid({ executor, runtimeData, sessionId, previousTurnId = null, configDirectory = "claude" }) {
  const normalizedSessionId = String(sessionId || "");
  if (!CLAUDE_NATIVE_UUID.test(normalizedSessionId)) return null;
  const projectsRoot = `${String(runtimeData || "")}/${String(configDirectory)}/projects`;
  if (!String(runtimeData || "")) return null;
  const prior = CLAUDE_NATIVE_UUID.test(String(previousTurnId || "")) ? String(previousTurnId) : "";
  // Neither terminal stream-json `result` exposes the final transcript message
  // UUID. Claude records it in `last-prompt.leafUuid`; Qoder records it in
  // `active-leaf.leafUuid`. Read the Agent-owned pointer after the turn instead
  // of copying, sorting or reconstructing its conversation.
  const script = [
    `projects_root=${shellQuote(projectsRoot)}`,
    `session_id=${shellQuote(normalizedSessionId)}`,
    "transcript=''",
    "fallback_transcript=''",
    "leaf=''",
    "assistant_leaf=''",
    "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 100; do",
    "  if [ -z \"$transcript\" ]; then",
    "    fallback_transcript=''",
    "    for candidate in \"$projects_root\"/*/\"$session_id.jsonl\"; do",
    "      [ -f \"$candidate\" ] || continue",
    "      if [ ! -L \"$candidate\" ]; then transcript=\"$candidate\"; break; fi",
    "      [ -n \"$fallback_transcript\" ] || fallback_transcript=\"$candidate\"",
    "    done",
    "    [ -n \"$transcript\" ] || transcript=\"$fallback_transcript\"",
    "  fi",
    `  if [ -n "$transcript" ]; then leaf="$(${transcriptLeafCommand(configDirectory)})"; fi`,
    `  if [ -n "$leaf" ] && { [ -z ${shellQuote(prior)} ] || [ "$leaf" != ${shellQuote(prior)} ]; } && grep -F \"\\\"uuid\\\":\\\"$leaf\\\"\" \"$transcript\" 2>/dev/null | grep -Fq '\"type\":\"assistant\"'; then assistant_leaf="$leaf"; break; fi`,
    "  sleep 0.05",
    "done",
    "[ -n \"$assistant_leaf\" ] && printf '%s\\n' \"$assistant_leaf\"",
  ].join("\n");
  const result = await executor.exec(`sh -c ${shellQuote(script)}`, { maxOutputBytes: 512 }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const leafUuid = String(result.stdout || "").trim().split(/\s+/)[0] || "";
  if (!CLAUDE_NATIVE_UUID.test(leafUuid) || leafUuid === prior) return null;
  return leafUuid;
}

async function* claudeFramesWithNativeBoundary(frames, options) {
  let sessionId = String(options.sessionId || "");
  let previousTurnId = options.previousTurnId || null;
  for await (const frame of frames) {
    if (frame?.session_id) sessionId = String(frame.session_id);
    if (frame?.type === "result" && CLAUDE_NATIVE_UUID.test(sessionId)) {
      const turnId = await claudeTranscriptLeafUuid({
        executor: options.executor,
        runtimeData: options.runtimeData,
        sessionId,
        previousTurnId,
        configDirectory: options.configDirectory || "claude",
      });
      // The boundary frame deliberately precedes `result`: result completes
      // the Task, after which the orchestrator stops consuming native frames.
      // A null turn clears an unsafe intermediate tool-use boundary so native
      // branch/revert can fall back instead of silently forking too early.
      yield { type: "easywork_native_boundary", session_id: sessionId, turn_id: turnId };
      if (turnId) previousTurnId = turnId;
    }
    yield frame;
  }
}

const CODEX_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
]);

const OPENCODE_DELTA_EVENTS = new Set([
  "session.next.text.delta",
  "session.next.reasoning.delta",
  "session.next.tool.input.delta",
  "message.part.delta",
  "message.part.updated",
]);

function sameFrameLane(previous, current, keys) {
  return keys.every((key) => String(previous?.[key] ?? "") === String(current?.[key] ?? ""));
}

function mergeCodexDelta(previous, current) {
  if (!previous || !current || previous.method !== current.method || !CODEX_DELTA_METHODS.has(current.method)) return undefined;
  const prior = previous.params;
  const next = current.params;
  if (!prior || !next || typeof prior.delta !== "string" || typeof next.delta !== "string") return undefined;
  if (!sameFrameLane(prior, next, ["threadId", "turnId", "itemId", "contentIndex", "summaryIndex", "index"])) return undefined;
  return { ...current, params: { ...next, delta: `${prior.delta}${next.delta}` } };
}

function openCodeLane(data) {
  const part = data?.part && typeof data.part === "object" && !Array.isArray(data.part) ? data.part : {};
  return {
    sessionId: data?.sessionID || data?.sessionId || part.sessionID || part.sessionId,
    messageId: data?.messageID || data?.messageId || part.messageID || part.messageId,
    partId: data?.partID || data?.partId || part.id,
    itemId: data?.textID || data?.reasoningID || data?.callID || data?.callId,
    field: data?.field,
    partType: part.type,
  };
}

function mergeOpenCodeDelta(previous, current) {
  if (!previous || !current || previous.type !== current.type || !OPENCODE_DELTA_EVENTS.has(current.type)) return undefined;
  const prior = previous.data;
  const next = current.data;
  if (!prior || !next || typeof prior.delta !== "string" || typeof next.delta !== "string") return undefined;
  if (!sameFrameLane(openCodeLane(prior), openCodeLane(next), ["sessionId", "messageId", "partId", "itemId", "field", "partType"])) return undefined;
  return { ...current, data: { ...next, delta: `${prior.delta}${next.delta}` } };
}

const CLAUDE_DELTA_FIELDS = Object.freeze({
  text_delta: "text",
  thinking_delta: "thinking",
  input_json_delta: "partial_json",
  compaction_delta: "content",
  signature_delta: "signature",
});

function mergeClaudeDelta(previous, current) {
  const priorEvent = previous?.type === "stream_event" ? previous.event : null;
  const nextEvent = current?.type === "stream_event" ? current.event : null;
  if (priorEvent?.type !== "content_block_delta" || nextEvent?.type !== "content_block_delta") return undefined;
  const priorDelta = priorEvent.delta;
  const nextDelta = nextEvent.delta;
  if (!priorDelta || !nextDelta || priorDelta.type !== nextDelta.type) return undefined;
  const field = CLAUDE_DELTA_FIELDS[nextDelta.type];
  if (!field || typeof priorDelta[field] !== "string" || typeof nextDelta[field] !== "string") return undefined;
  if (!sameFrameLane(previous, current, ["session_id", "parent_tool_use_id"]) || String(priorEvent.index ?? "") !== String(nextEvent.index ?? "")) return undefined;
  return {
    ...current,
    event: {
      ...nextEvent,
      delta: { ...nextDelta, [field]: `${priorDelta[field]}${nextDelta[field]}` },
    },
  };
}

function agentFrameMerger(agentId) {
  if (agentId === "codex") return mergeCodexDelta;
  if (agentId === "opencode") return mergeOpenCodeDelta;
  if (["claude-code", "qoder-cn"].includes(agentId)) return mergeClaudeDelta;
  return null;
}

function agentLineMerger(agentId) {
  const merge = agentFrameMerger(agentId);
  if (!merge) return null;
  return (previous, current) => {
    const merged = merge(frameFromLine(previous), frameFromLine(current));
    return merged === undefined ? undefined : JSON.stringify(merged);
  };
}

function claudeThinkingTelemetrySuperseded(previous, current) {
  const previousIsThinkingTelemetry = previous?.type === "system" && previous?.subtype === "thinking_tokens";
  const currentIsThinkingTelemetry = current?.type === "system" && current?.subtype === "thinking_tokens";
  const currentIsAssistantContent = current?.type === "assistant"
    || (current?.type === "stream_event" && current?.event?.type === "content_block_delta");
  // Claude emits a cumulative `thinking_tokens` counter between nearly every
  // thinking delta. Once a newer counter or assistant-content frame is queued,
  // that older counter is stale. Removing it also lets adjacent logical deltas
  // merge instead of accumulating thousands of alternating queue entries.
  // SDKAssistantMessage delivers a completed content block, not a cumulative
  // snapshot of every block sharing message.id. Stream lifecycle/usage frames
  // contain different information again. None may replace one another: doing
  // so can discard the end of tool JSON and then its complete tool_use input.
  return previousIsThinkingTelemetry && (currentIsThinkingTelemetry || currentIsAssistantContent)
    && sameFrameLane(previous, current, ["session_id", "parent_tool_use_id"]);
}

function agentQueueOptions(agentId) {
  return {
    merge: agentFrameMerger(agentId),
    ...(["claude-code", "qoder-cn"].includes(agentId) ? {
      discardPrevious: claudeThinkingTelemetrySuperseded,
    } : {}),
  };
}

function agentLineQueueOptions(agentId) {
  const options = agentQueueOptions(agentId);
  return {
    merge: agentLineMerger(agentId),
    ...(options.discardPrevious ? {
      discardPrevious: (previous, current) => options.discardPrevious(frameFromLine(previous), frameFromLine(current)),
    } : {}),
  };
}

function coalescedAgentFrames(frames, agentId, options = {}) {
  const iterator = frames[Symbol.asyncIterator]();
  const queue = new AsyncQueue(
    () => { void iterator.return?.(); },
    { ...options, ...agentQueueOptions(agentId) },
  );
  void (async () => {
    try {
      while (!queue.done) {
        const next = await iterator.next();
        if (next.done) break;
        queue.push(next.value);
      }
      queue.end();
    } catch (error) {
      queue.end(error);
    }
  })();
  return queue;
}

async function* framesWithRequiredPersistence(frames, persistenceOutcome, agentVersion = "unknown") {
  let streamError = null;
  try {
    for await (const frame of frames) {
      yield {
        ...frame,
        easywork: {
          ...(frame?.easywork && typeof frame.easywork === "object" && !Array.isArray(frame.easywork) ? frame.easywork : {}),
          agentVersion: String(agentVersion || "unknown"),
        },
      };
    }
  } catch (error) {
    streamError = error;
  } finally {
    const persistenceError = await persistenceOutcome;
    if (streamError) throw streamError;
    if (persistenceError) throw persistenceError;
  }
}

async function* withNativeSubmission(frames, submission) {
  if (!submission) { yield* frames; return; }
  const failure = submission.then(() => new Promise(() => {}), (error) => { throw error; });
  failure.catch(() => undefined);
  const iterator = frames[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), failure]);
      if (next.done) { await submission; return; }
      yield next.value;
    }
  } finally { await iterator.return?.(); }
}

function effortAdjustmentProtocolFrame(agentId, detail, agentVersion = "unknown") {
  const easywork = { agentVersion: String(agentVersion || "unknown"), eventSource: "effort-adaptation" };
  if (agentId === "opencode") return { type: "easywork.effort.adjusted", data: detail, easywork };
  if (agentId === "codex") return { method: "easywork/effortAdjusted", params: detail, easywork };
  return { type: "easywork_effort_adjusted", adjustment: detail, easywork };
}

async function drainEffortAdjustmentQueue(queue, agentId, agentVersion) {
  const frames = [];
  while (queue.length) {
    const pending = queue.shift();
    const detail = await pending;
    if (detail) frames.push(effortAdjustmentProtocolFrame(agentId, detail, agentVersion));
  }
  return frames;
}

async function* framesWithEffortAdjustments(frames, { queue, agentId, agentVersion, release }) {
  try {
    for await (const frame of frames) {
      for (const adjustment of await drainEffortAdjustmentQueue(queue, agentId, agentVersion)) yield adjustment;
      yield frame;
    }
    for (const adjustment of await drainEffortAdjustmentQueue(queue, agentId, agentVersion)) yield adjustment;
  } finally {
    release?.();
  }
}

const CLAUDE_CLIENT_REQUESTS = new Set(["can_use_tool", "elicitation", "request_user_dialog"]);

function claudeTurnQueue(entry) {
  if (!entry.turnQueue) entry.turnQueue = { submitted: 0, completed: 0 };
  return entry.turnQueue;
}

function writeClaudeFrame(entry, frame) {
  if (frame?.type === "user") claudeTurnQueue(entry).submitted += 1;
  entry.process.writeJson(frame);
}

function claudeInterruptDiagnosticResult(frame) {
  if (frame?.type !== "result" || frame?.subtype !== "error_during_execution" || frame?.is_error !== true) return false;
  const values = [frame?.result, ...(Array.isArray(frame?.errors) ? frame.errors : [])];
  return values.some((value) => typeof value === "string"
    && /^\[ede_diagnostic\]\s+result_type=user\b.*\bstop_reason=(?:tool_use|null)\b/i.test(value.trim()));
}

function claudeResultWithTurnBoundary(entry, frame) {
  const queue = claudeTurnQueue(entry);
  queue.completed += 1;
  const locallyQueued = Math.max(0, queue.submitted - queue.completed);
  const reported = Number.isInteger(frame?.queued_turn_count) && frame.queued_turn_count >= 0
    ? frame.queued_turn_count
    : null;
  // Claude Code >= 2.1.243 exposes the authoritative command-queue count.
  // Older builds do not, so retain a scoped compatibility count of user
  // frames written to this exact process. The native count wins when present
  // because several queued sends may coalesce into fewer subsequent turns.
  // Claude Code currently misclassifies a normal interrupt at a thinking or
  // tool-use boundary as error_during_execution and can report zero queued
  // turns before it observes the follow-up user frame already written to the
  // same stream-json process. Keep that known boundary non-terminal exactly
  // when this scoped process proves a follow-up is pending. Other native queue
  // counts remain authoritative so coalesced sends cannot strand the stream.
  const interruptedBeforeQueuedFollowup = reported === 0
    && locallyQueued > 0
    && claudeInterruptDiagnosticResult(frame);
  const queuedTurnCount = interruptedBeforeQueuedFollowup ? locallyQueued : reported ?? locallyQueued;
  return {
    ...frame,
    easywork: {
      ...(frame?.easywork && typeof frame.easywork === "object" && !Array.isArray(frame.easywork) ? frame.easywork : {}),
      terminalResult: queuedTurnCount === 0,
      queuedTurnCount,
      queueSource: interruptedBeforeQueuedFollowup ? "scoped-interrupt" : reported === null ? "scoped-process" : "native",
    },
  };
}

async function* scopedClaudeFrames(lines, entry) {
  const process = entry.process;
  let terminalResult = false;
  try {
    for await (const frame of parsedFrames(lines)) {
      if (frame?.type === "control_request") {
        const subtype = String(frame.request?.subtype || "");
        if (!CLAUDE_CLIENT_REQUESTS.has(subtype)) {
          process.writeJson({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: String(frame.request_id || ""),
              error: `EasyWork 未协商 ${entry.agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 控制请求：${subtype || "unknown"}`,
            },
          });
        }
      }
      if (frame?.type === "result") {
        const result = claudeResultWithTurnBoundary(entry, frame);
        // A result ends exactly one Claude turn. Keep the bidirectional stream
        // open while native queued sends remain; only the run-ending result
        // releases stdin and the scoped SSH channel.
        if (result.easywork.terminalResult) process.endInput?.();
        yield result;
        if (result.easywork.terminalResult) {
          terminalResult = true;
          return;
        }
        continue;
      }
      yield frame;
    }
    if (!terminalResult) {
      let exit = null;
      try { exit = typeof process.wait === "function" ? await process.wait() : null; }
      catch (error) {
        throw new ApiError("AGENT_PROCESS_EXITED_WITHOUT_RESULT", `${entry.agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 进程在返回最终结果前异常退出`, {
          status: 502,
          expose: true,
          retryable: true,
          details: { reason: String(error?.message || error || "process_wait_failed") },
          cause: error,
        });
      }
      const stderr = String(process.diagnosticStderr || process.stderr || "")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim()
        .slice(-4_096);
      const detail = stderr ? `：${stderr.split(/\r?\n/).filter(Boolean).at(-1)}` : "";
      throw new ApiError("AGENT_PROCESS_EXITED_WITHOUT_RESULT", `${entry.agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 进程在返回最终结果前退出${detail}`, {
        status: 502,
        expose: true,
        retryable: true,
        details: redactSensitive({ exitCode: exit?.code ?? null, signal: exit?.signal ?? null, stderr: stderr || null }),
      });
    }
  } finally {
    // Also release the process when parsing, persistence, or the downstream
    // event consumer ends the stream before Claude can emit a result.
    process.endInput?.();
  }
}

const CLAUDE_EFFORT_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

function claudeFrameText(frame) {
  const values = [];
  for (const value of [
    frame?.result,
    frame?.error,
    frame?.message?.error,
    frame?.compact_error,
    ...(Array.isArray(frame?.errors) ? frame.errors : []),
  ]) {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  const content = Array.isArray(frame?.message?.content) ? frame.message.content : [];
  for (const block of content) {
    for (const value of [block?.text, block?.thinking]) {
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    }
  }
  return values.join("\n");
}

function compactFailure(agentLabel, frame, priorMessage = "") {
  const detail = claudeFrameText(frame) || String(priorMessage || "").trim();
  const failed = frame?.is_error === true
    || (frame?.subtype && frame.subtype !== "success")
    || frame?.compact_result === "failed";
  const message = detail
    ? `${agentLabel} 上下文压缩${failed ? "失败" : "未执行"}：${detail}`
    : `${agentLabel} 原生进程已结束压缩请求，但没有返回完成边界`;
  return new ApiError(failed ? "AGENT_COMPACT_FAILED" : "AGENT_COMPACT_NOT_APPLIED", message, {
    status: failed ? 502 : 409,
    retryable: failed,
    expose: true,
    details: {
      subtype: String(frame?.subtype || ""),
      isError: frame?.is_error === true,
    },
  });
}

async function executeClaudeCompact({ entry, frames, agentLabel, terminateAfter = false, timeoutMs = 90_000 }) {
  // Subscribe before writing `/compact`: a local or fast remote process can
  // publish its boundary/result before the write promise yields back to us.
  const lines = entry.process.lines(agentLineQueueOptions(entry.agentId));
  const parsed = parsedFrames(lines);
  const iterator = parsed[Symbol.asyncIterator]();
  const queue = claudeTurnQueue(entry);
  let precedingResults = Math.max(0, queue.submitted - queue.completed);
  let lastMessage = "";
  let pendingNext = null;
  const deadline = Date.now() + timeoutMs;
  try {
    for (const frame of frames || []) writeClaudeFrame(entry, frame);
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ApiError("AGENT_COMPACT_TIMEOUT", `${agentLabel} 上下文压缩等待原生结果超时`, {
          status: 504,
          retryable: true,
          expose: true,
        });
      }
      pendingNext = iterator.next();
      let timer;
      const next = await Promise.race([
        pendingNext,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), remaining); }),
      ]).finally(() => clearTimeout(timer));
      if (next?.timeout) {
        throw new ApiError("AGENT_COMPACT_TIMEOUT", `${agentLabel} 上下文压缩等待原生结果超时`, {
          status: 504,
          retryable: true,
          expose: true,
        });
      }
      pendingNext = null;
      if (next.done) {
        throw new ApiError("AGENT_COMPACT_INCOMPLETE", `${agentLabel} 原生进程已结束，但没有返回压缩完成边界`, {
          status: 502,
          retryable: true,
          expose: true,
        });
      }
      const frame = next.value;
      if (frame?.type === "system" && frame?.subtype === "compact_boundary") return frame;
      const message = claudeFrameText(frame);
      if (message) lastMessage = message;
      if (frame?.type === "system" && frame?.subtype === "status" && frame?.compact_result === "failed") {
        throw compactFailure(agentLabel, frame, lastMessage);
      }
      if (frame?.type !== "result") continue;
      // An active process can still be finishing turns that were submitted
      // before `/compact`. Their result frames are not the compact outcome.
      if (precedingResults > 0) {
        precedingResults -= 1;
        lastMessage = "";
        continue;
      }
      // A successful native compact always publishes compact_boundary before
      // its terminal result. A result without that boundary is a native no-op
      // or failure (too-short context, auth/quota failure, blocked hook, etc.).
      throw compactFailure(agentLabel, frame, lastMessage);
    }
  } finally {
    // Cancel a pending read before returning the parsed generator. Without
    // this, an actual timeout can remain blocked in iterator.next().
    try { await lines.return?.(); } catch { /* best-effort subscription cleanup */ }
    if (pendingNext) await pendingNext.catch(() => undefined);
    try { await iterator.return?.(); } catch { /* best-effort parser cleanup */ }
    entry.process.endInput?.();
    if (terminateAfter && !entry.process.closed) {
      await entry.process.signal("SIGTERM").catch(() => undefined);
    }
  }
}

function claudeUnsupportedEffort(frame) {
  const text = claudeFrameText(frame);
  const match = text.match(/Unexpected reasoning effort\s+([A-Za-z0-9_-]+)\.\s*Supported types are\s+([^\r\n.]+)\.?/i);
  if (!match) return null;
  const allowed = [...new Set(match[2]
    .replace(/\(default\)/gi, "")
    .split(/\s*,\s*|\s+and\s+/i)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => CLAUDE_EFFORT_ORDER.includes(value)))];
  return allowed.length ? { requested: match[1].toLowerCase(), allowed } : null;
}

function nearestClaudeEffort(requested, allowed) {
  const requestedIndex = CLAUDE_EFFORT_ORDER.indexOf(String(requested || "").toLowerCase());
  const candidates = [...new Set((allowed || []).map((value) => String(value).toLowerCase()))]
    .map((value) => ({ value, index: CLAUDE_EFFORT_ORDER.indexOf(value) }))
    .filter((entry) => entry.index >= 0 && entry.index !== requestedIndex);
  if (!candidates.length) return null;
  if (requestedIndex < 0) return candidates.sort((left, right) => right.index - left.index)[0].value;
  const stronger = candidates
    .filter((entry) => entry.index > requestedIndex)
    .sort((left, right) => left.index - right.index);
  if (stronger.length) return stronger[0].value;
  return candidates.sort((left, right) => right.index - left.index)[0].value;
}

function claudeFrameHasSubstantiveActivity(frame) {
  if (!frame || claudeUnsupportedEffort(frame)) return false;
  if (frame.type === "stream_event") {
    const event = frame.event || {};
    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      return block.type === "tool_use"
        || [block.text, block.thinking].some((value) => typeof value === "string" && value.length > 0);
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      return [delta.text, delta.thinking, delta.partial_json].some((value) => typeof value === "string" && value.length > 0);
    }
    return false;
  }
  if (frame.type === "assistant") {
    return (Array.isArray(frame.message?.content) ? frame.message.content : []).some((block) => (
      block?.type === "tool_use"
      || [block?.text, block?.thinking].some((value) => typeof value === "string" && value.length > 0)
    ));
  }
  // A tool result means the rejected request has already crossed a side-effect
  // boundary, so it must never be replayed automatically.
  return frame.type === "user" && Array.isArray(frame.message?.content)
    && frame.message.content.some((block) => block?.type === "tool_result");
}

function claudeFrameLooksLikeEarlyError(frame) {
  if (frame?.type !== "assistant") return false;
  if (typeof frame.message?.error === "string" && frame.message.error.trim()) return true;
  return /^API Error:/i.test(claudeFrameText(frame));
}

async function* adaptiveClaudeEffortFrames(frames, { requestedEffort, retry }) {
  const buffered = [];
  let unsupported = null;
  let substantive = false;
  for await (const frame of frames) {
    if (substantive) {
      yield frame;
      continue;
    }
    const currentUnsupported = claudeUnsupportedEffort(frame);
    unsupported = currentUnsupported || unsupported;
    if (claudeFrameHasSubstantiveActivity(frame)) {
      substantive = true;
      for (const bufferedFrame of buffered.splice(0)) yield bufferedFrame;
      yield frame;
      continue;
    }
    if (unsupported || currentUnsupported || claudeFrameLooksLikeEarlyError(frame) || frame?.type === "result") buffered.push(frame);
    else {
      // Native initialization and status frames are safe to expose early. A
      // later successful retry supplies a new session frame that becomes the
      // authoritative binding without delaying normal context telemetry.
      yield frame;
      continue;
    }
    if (frame?.type !== "result") continue;
    const fallback = unsupported
      ? nearestClaudeEffort(unsupported.requested || requestedEffort, unsupported.allowed)
      : null;
    const retried = fallback && typeof retry === "function" ? await retry(fallback) : null;
    if (retried) {
      for await (const retryFrame of retried) yield retryFrame;
      return;
    }
    for (const bufferedFrame of buffered.splice(0)) yield bufferedFrame;
  }
  for (const bufferedFrame of buffered) yield bufferedFrame;
}

function codexFrameThreadId(frame) {
  const params = frame?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  return String(params.threadId || params.thread?.id || "");
}

function codexFrameTurnId(frame) {
  const params = frame?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  return String(params.turnId || params.turn?.id || "");
}

const CODEX_INTERACTIVE_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  // Still part of the current app-server contract for clients that use the
  // legacy approval request names. They carry the same ReviewDecision reply.
  "execCommandApproval",
  "applyPatchApproval",
]);

async function* scopedCodexFrames(lines, { scope, process, onClose }) {
  try {
    for await (const frame of parsedFrames(lines)) {
      const threadId = String(scope?.threadId || "");
      const turnId = String(scope?.turnId || "");
      const frameThreadId = codexFrameThreadId(frame);
      const frameTurnId = codexFrameTurnId(frame);
      if (threadId && frameThreadId && frameThreadId !== threadId) continue;
      if (turnId && frameTurnId && frameTurnId !== turnId) continue;
      if (frame?.id != null && typeof frame.method === "string") {
        if (frame.method === "currentTime/read") {
          process.respondJsonRpc(frame.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
          continue;
        }
        if (!CODEX_INTERACTIVE_REQUESTS.has(frame.method)) {
          process.rejectJsonRpc(frame.id, -32601, `EasyWork 未协商 Codex 服务端请求：${frame.method}`);
        }
      }
      yield frame;
    }
  } finally {
    onClose?.();
  }
}

function normalizeOpenCodeFrame(frame, source) {
  invariant(frame && typeof frame === "object" && !Array.isArray(frame), "AGENT_EVENT_INVALID", "OpenCode 返回了无效事件", { status: 502 });
  // Older OpenCode global streams wrap the native V1 event in `payload`, while
  // the workspace stream sends `{ type, properties }` directly.  Unwrap only
  // a structurally valid event so an unrelated payload can never be mistaken
  // for the protocol envelope.
  const wrapped = frame.payload
    && typeof frame.payload === "object"
    && !Array.isArray(frame.payload)
    && typeof frame.payload.type === "string"
    ? frame.payload
    : frame;
  const type = String(wrapped.type || wrapped.event || "unknown");
  const payload = wrapped.data && typeof wrapped.data === "object" && !Array.isArray(wrapped.data)
    ? wrapped.data
    : wrapped.properties && typeof wrapped.properties === "object" && !Array.isArray(wrapped.properties)
      ? wrapped.properties
      : {};
  return {
    ...wrapped,
    type,
    data: payload,
    easywork: {
      ...(frame.easywork && typeof frame.easywork === "object" && !Array.isArray(frame.easywork) ? frame.easywork : {}),
      ...(wrapped.easywork && typeof wrapped.easywork === "object" && !Array.isArray(wrapped.easywork) ? wrapped.easywork : {}),
      eventEnvelope: wrapped.data === payload ? "data" : wrapped.properties === payload ? "properties" : "empty",
      eventSource: String(source || "unknown"),
      ...(wrapped !== frame && typeof frame.directory === "string" ? { eventDirectory: frame.directory } : {}),
    },
  };
}

function openCodeFrameSessionId(frame) {
  const data = frame?.data && typeof frame.data === "object" ? frame.data : {};
  const info = data.info || data.message || {};
  const part = data.part || {};
  return String(data.sessionID || data.sessionId || info.sessionID || info.sessionId || part.sessionID || part.sessionId || "");
}

function openCodeEventSequence(frame) {
  const sequence = Number(frame?.durable?.seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function openCodeFrameIsTerminal(frame) {
  if (frame?.type === "session.next.step.failed") return true;
  if (frame?.type !== "session.next.step.ended") return false;
  return String(frame?.data?.finish || "") !== "tool-calls";
}

async function openCodeHistory(executor, port, sessionId, afterSequence) {
  const events = [];
  let after = afterSequence;
  while (true) {
    const result = await executor.requestHttp({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: `/api/session/${encodeURIComponent(sessionId)}/history?after=${after}&limit=100`,
    });
    const page = Array.isArray(result?.data) ? result.data : [];
    for (const rawFrame of page) {
      const frame = normalizeOpenCodeFrame(rawFrame, "history");
      const sequence = openCodeEventSequence(frame);
      if (sequence === null || sequence <= after) continue;
      events.push(frame);
      after = sequence;
    }
    if (result?.hasMore !== true || page.length === 0) break;
  }
  return events;
}

async function* resilientOpenCodeFrames({ lines, executor, port, sessionId, afterSequence, pollIntervalMs }) {
  const iterator = lines[Symbol.asyncIterator]();
  let latestSequence = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
  let inactivePolls = 0;
  let pending = iterator.next().then(
    (result) => ({ type: "line", result }),
    (error) => ({ type: "error", error }),
  );

  const recoverHistory = async () => {
    const recovered = await openCodeHistory(executor, port, sessionId, latestSequence);
    const frames = [];
    for (const frame of recovered) {
      const sequence = openCodeEventSequence(frame);
      if (sequence === null || sequence <= latestSequence) continue;
      latestSequence = sequence;
      frames.push(frame);
    }
    return frames;
  };

  try {
    while (true) {
      const next = await Promise.race([
        pending,
        sleep(pollIntervalMs).then(() => ({ type: "poll" })),
      ]);
      if (next.type === "error") throw next.error;
      if (next.type === "line") {
        if (next.result.done) {
          const recovered = await recoverHistory();
          for (const frame of recovered) {
            yield frame;
            if (openCodeFrameIsTerminal(frame)) return;
          }
          throw new ApiError("AGENT_EVENT_STREAM_ENDED", "OpenCode 当前事件流在终态事件前结束", {
            status: 502,
            retryable: true,
            details: { sessionId, afterSequence: latestSequence },
          });
        }
        pending = iterator.next().then(
          (result) => ({ type: "line", result }),
          (error) => ({ type: "error", error }),
        );
        const rawFrame = frameFromLine(next.result.value, { sse: true });
        if (!rawFrame) continue;
        const frame = normalizeOpenCodeFrame(rawFrame, "event-stream");
        const frameSessionId = openCodeFrameSessionId(frame);
        if (!frameSessionId || frameSessionId !== sessionId) continue;
        inactivePolls = 0;
        const sequence = openCodeEventSequence(frame);
        if (sequence !== null) {
          if (sequence <= latestSequence) continue;
          if (sequence > latestSequence + 1) {
            const recovered = await recoverHistory();
            for (const recoveredFrame of recovered) {
              yield recoveredFrame;
              if (openCodeFrameIsTerminal(recoveredFrame)) return;
            }
            if (sequence <= latestSequence) continue;
          }
          latestSequence = sequence;
        }
        yield frame;
        if (openCodeFrameIsTerminal(frame)) return;
        continue;
      }

      let snapshot;
      try {
        snapshot = await executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/api/session/active" });
      } catch {
        continue;
      }
      if (openCodeSessionIsBusy(snapshot, sessionId)) {
        inactivePolls = 0;
        continue;
      }
      try {
        const recovered = await recoverHistory();
        for (const frame of recovered) {
          yield frame;
          if (openCodeFrameIsTerminal(frame)) return;
        }
      } catch {
        continue;
      }
      inactivePolls += 1;
      if (inactivePolls < 20) continue;
      throw new ApiError("AGENT_EVENT_TERMINAL_MISSING", "OpenCode 已停止运行，但没有返回当前协议的终态事件", {
        status: 502,
        retryable: true,
        details: { sessionId, afterSequence: latestSequence },
      });
    }
  } finally {
    await iterator.return?.();
  }
}

function openCodeV1MessageId(message) {
  return String(message?.info?.id || message?.id || "");
}

function openCodeV1PartId(part) {
  return String(part?.id || "");
}

function openCodeStableFingerprint(value) {
  try { return JSON.stringify(value); } catch { return ""; }
}

function completedOpenCodeV1Turn(messages, baselineMessageIds) {
  const created = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.info?.role === "assistant" && !baselineMessageIds.has(openCodeV1MessageId(message)))
    .sort((left, right) => Number(left?.info?.time?.created || 0) - Number(right?.info?.time?.created || 0));
  const terminal = [...created].reverse().find((message) => {
    const finish = String(message?.info?.finish || "").toLowerCase();
    return Boolean(message?.info?.time?.completed) && finish && finish !== "tool-calls";
  });
  return terminal ? created : [];
}

async function openCodeV1Messages(executor, port, sessionId) {
  const result = await executor.requestHttp({
    host: "127.0.0.1",
    port,
    method: "GET",
    path: `/session/${encodeURIComponent(sessionId)}/message`,
  });
  return Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
}

async function openOpenCodeEventStream(executor, port, protocol, directory = "") {
  if (protocol !== "v1") {
    return executor.openHttpEventStream({ host: "127.0.0.1", port, path: "/api/event" });
  }
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  try {
    return await executor.openHttpEventStream({ host: "127.0.0.1", port, path: `/event${query}` });
  } catch (workspaceStreamError) {
    try {
      return await executor.openHttpEventStream({ host: "127.0.0.1", port, path: "/global/event" });
    } catch (globalStreamError) {
      throw new ApiError("AGENT_EVENT_STREAM_UNAVAILABLE", "OpenCode V1 没有可用的原生事件流", {
        status: 502,
        retryable: true,
        details: {
          protocol: "v1",
          workspaceReason: String(workspaceStreamError?.code || workspaceStreamError?.message || "event_unavailable"),
          globalReason: String(globalStreamError?.code || globalStreamError?.message || "global_event_unavailable"),
        },
        cause: globalStreamError,
      });
    }
  }
}

async function* resilientOpenCodeV1Frames({ lines, executor, port, sessionId, baselineMessageIds, pollIntervalMs, agentVersion = "unknown", directory = "" }) {
  const iterator = lines[Symbol.asyncIterator]();
  const observedMessages = new Map();
  const observedParts = new Map();
  let inactivePolls = 0;
  let pending = iterator.next().then(
    (result) => ({ type: "line", result }),
    (error) => ({ type: "error", error }),
  );

  const replayCompletedTurn = async () => {
    const completed = completedOpenCodeV1Turn(await openCodeV1Messages(executor, port, sessionId), baselineMessageIds);
    const frames = [];
    for (const message of completed) {
      const info = message?.info || {};
      const messageId = openCodeV1MessageId(message);
      const infoFingerprint = openCodeStableFingerprint(info);
      if (messageId && observedMessages.get(messageId) !== infoFingerprint) {
        observedMessages.set(messageId, infoFingerprint);
        frames.push(normalizeOpenCodeFrame({ type: "message.updated", properties: { info } }, "v1-history"));
      }
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        const partId = openCodeV1PartId(part);
        const partFingerprint = openCodeStableFingerprint(part);
        if (partId && observedParts.get(partId) === partFingerprint) continue;
        if (partId) observedParts.set(partId, partFingerprint);
        frames.push(normalizeOpenCodeFrame({ type: "message.part.updated", properties: { part } }, "v1-history"));
      }
    }
    return { completed: completed.length > 0, frames };
  };

  try {
    while (true) {
      const next = await Promise.race([
        pending,
        sleep(pollIntervalMs).then(() => ({ type: "poll" })),
      ]);
      if (next.type === "error") throw next.error;
      if (next.type === "line") {
        if (next.result.done) {
          const recovered = await replayCompletedTurn();
          for (const frame of recovered.frames) yield frame;
          if (recovered.completed) {
            yield normalizeOpenCodeFrame({ type: "session.idle", properties: { sessionID: sessionId } }, "v1-history");
            return;
          }
          throw new ApiError("AGENT_EVENT_STREAM_ENDED", `OpenCode ${agentVersion} V1 事件流在会话终态前结束`, {
            status: 502,
            retryable: true,
            details: { sessionId, protocol: "v1", actualVersion: agentVersion },
          });
        }
        pending = iterator.next().then(
          (result) => ({ type: "line", result }),
          (error) => ({ type: "error", error }),
        );
        const rawFrame = frameFromLine(next.result.value, { sse: true });
        if (!rawFrame) continue;
        const frame = normalizeOpenCodeFrame(rawFrame, "v1-event-stream");
        if (frame.easywork?.eventDirectory && directory && frame.easywork.eventDirectory !== directory) continue;
        const frameSessionId = openCodeFrameSessionId(frame);
        if (frameSessionId && frameSessionId !== sessionId) continue;
        const info = frame.data?.info || frame.data?.message;
        const part = frame.data?.part;
        if (info?.id) observedMessages.set(String(info.id), openCodeStableFingerprint(info));
        if (part?.id) observedParts.set(String(part.id), openCodeStableFingerprint(part));
        inactivePolls = 0;
        const idle = frame.type === "session.idle"
          || (frame.type === "session.status" && String(frame.data?.status?.type || frame.data?.status || "").toLowerCase() === "idle");
        if (idle) {
          const recovered = await replayCompletedTurn();
          for (const historyFrame of recovered.frames) yield historyFrame;
          yield frame;
          return;
        }
        yield frame;
        if (frame.type === "session.error") return;
        continue;
      }

      let snapshot;
      try {
        snapshot = await executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/session/status" });
      } catch {
        continue;
      }
      if (openCodeSessionIsBusy(snapshot, sessionId, "v1")) {
        inactivePolls = 0;
        continue;
      }
      let recovered;
      try {
        recovered = await replayCompletedTurn();
        for (const frame of recovered.frames) yield frame;
      } catch {
        continue;
      }
      if (recovered.completed) {
        yield normalizeOpenCodeFrame({ type: "session.idle", properties: { sessionID: sessionId } }, "v1-history");
        return;
      }
      inactivePolls += 1;
      if (inactivePolls < 40) continue;
      throw new ApiError("AGENT_EVENT_TERMINAL_MISSING", `OpenCode ${agentVersion} V1 已停止运行，但没有返回可确认的会话终态`, {
        status: 502,
        retryable: true,
        details: { sessionId, protocol: "v1", actualVersion: agentVersion },
      });
    }
  } finally {
    await iterator.return?.();
  }
}

function openCodeMutationSnapshot(frame, toolCalls, workspacePath, taskId) {
  const current = frame?.type === "permission.v2.asked";
  const compatible = ["permission.updated", "permission.asked"].includes(frame?.type);
  if (!current && !compatible) return null;
  const raw = frame.data?.permission && typeof frame.data.permission === "object" ? frame.data.permission : frame.data;
  const data = raw && typeof raw === "object" ? raw : {};
  const action = String(current ? data.action || "" : data.type || data.permission || "").toLowerCase();
  if (!['edit', 'bash'].includes(action)) return null;
  const requestId = String(data?.id || "");
  const callId = String(current ? data?.source?.callID || "" : data?.tool?.callID || data?.tool?.callId || data?.callID || data?.callId || "");
  invariant(requestId && callId, "AGENT_OPENCODE_PERMISSION_INVALID", "OpenCode 文件操作审批缺少当前协议标识", { status: 502 });
  const known = toolCalls.get(callId) || {};
  const input = known.input && typeof known.input === "object" && !Array.isArray(known.input) ? known.input : {};
  const resourceValue = current ? data.resources : data.patterns || data.pattern;
  const resources = (Array.isArray(resourceValue) ? resourceValue : resourceValue ? [resourceValue] : []).map(String).filter(Boolean);
  let cwd = String(workspacePath || "/");
  if (action === "bash" && typeof input.workdir === "string" && input.workdir.trim()) {
    cwd = path.posix.resolve(cwd, input.workdir.trim());
  }
  return {
    requestId,
    payload: {
      hook_event_name: "PreToolUse",
      easywork_task_id: String(taskId || ""),
      cwd,
      tool_name: action,
      tool_input: action === "bash"
        ? { command: typeof input.command === "string" ? input.command : String(resources[0] || "") }
        : { paths: resources },
      tool_use_id: callId,
    },
  };
}

async function abortGovernedOpenCodeRun(executor, port, sessionId, protocol, workspacePath) {
  const directory = String(workspacePath || "").trim();
  const query = protocol === "v1" && directory ? `?directory=${encodeURIComponent(directory)}` : "";
  await executor.requestHttp({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: protocol === "v1"
      ? `/session/${encodeURIComponent(sessionId)}/abort${query}`
      : `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
  });
}

async function captureOpenCodeMutation(executor, paths, snapshot) {
  const input = JSON.stringify(snapshot.payload);
  const command = `printf '%s' ${shellQuote(input)} | ${versionHookCommand(paths)}`;
  const result = await executor.exec(command, { maxOutputBytes: 64 * 1024 });
  invariant(result.code === 0, "AGENT_OPENCODE_VERSION_CAPTURE_FAILED", "OpenCode 文件操作前版本记录失败", {
    status: 502,
    details: { reason: String(result.stderr || "snapshot_failed").trim().slice(0, 1_000) },
  });
}

async function* governedOpenCodeFrames({ frames, executor, port, sessionId, protocol, permissionMode, paths, workspacePath, taskId }) {
  const toolCalls = new Map();
  const internalReplies = new Set();
  for await (const frame of frames) {
    const data = frame.data;
    if (frame.type === "session.next.tool.called") {
      const callId = String(data?.callID || "");
      if (callId) toolCalls.set(callId, { tool: String(data?.tool || ""), input: data?.input });
    } else if (frame.type === "message.part.updated" && data?.part?.type === "tool") {
      const part = data.part;
      const callId = String(part.callID || part.callId || part.id || "");
      const state = part.state && typeof part.state === "object" ? part.state : {};
      if (callId) toolCalls.set(callId, { tool: String(part.tool || part.name || ""), input: state.input || part.input });
    }
    const snapshot = openCodeMutationSnapshot(frame, toolCalls, workspacePath, taskId);
    if (snapshot) {
      // OpenCode V1 can bridge the same pending request through both
      // `permission.updated` and `permission.asked`. Permission.reply removes
      // the request from its native pending map, so a second HTTP reply is not
      // a harmless refresh: current releases return 404 and would fail the
      // whole Agent turn. Treat the native request id as the idempotency key
      // for this stream, including the subsequent permission.replied echo.
      if (internalReplies.has(snapshot.requestId)) continue;
      try {
        await captureOpenCodeMutation(executor, paths, snapshot);
      } catch (error) {
        // A failed pre-mutation snapshot must deny the pending native tool.
        // Abort the native turn before surfacing the Task failure so the same
        // OpenCode session is idle and cannot execute this stale permission
        // after the next Web turn updates its Task boundary.
        await abortGovernedOpenCodeRun(executor, port, sessionId, protocol, workspacePath).catch(() => undefined);
        throw error;
      }
      if (permissionMode === "allow") {
        const directory = String(workspacePath || "").trim();
        const query = directory ? `?directory=${encodeURIComponent(directory)}` : "";
        internalReplies.add(snapshot.requestId);
        try {
          await executor.requestHttp(protocol === "v1" ? {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `/permission/${encodeURIComponent(snapshot.requestId)}/reply${query}`,
            body: { reply: "once" },
          } : {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(snapshot.requestId)}/reply`,
            body: { reply: "once" },
          });
        } catch (error) {
          internalReplies.delete(snapshot.requestId);
          await abortGovernedOpenCodeRun(executor, port, sessionId, protocol, workspacePath).catch(() => undefined);
          throw error;
        }
        continue;
      }
    }
    if (["permission.v2.replied", "permission.replied"].includes(frame.type)) {
      const requestId = String(data?.requestID || data?.permissionID || "");
      if (internalReplies.has(requestId)) continue;
    }
    yield frame;
    if (["session.next.tool.success", "session.next.tool.failed"].includes(frame.type)) {
      const callId = String(data?.callID || "");
      if (callId) toolCalls.delete(callId);
    } else if (frame.type === "message.part.updated" && data?.part?.type === "tool") {
      const part = data.part;
      const status = String(part.state?.status || "").toLowerCase();
      if (["completed", "error", "failed"].includes(status)) toolCalls.delete(String(part.callID || part.callId || part.id || ""));
    }
  }
}

function deepSubstitute(value, variables) {
  if (typeof value === "string") {
    if (variables[value] !== undefined) return variables[value];
    return Object.entries(variables).reduce(
      (resolved, [placeholder, replacement]) => resolved.split(placeholder).join(String(replacement)),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => deepSubstitute(entry, variables));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepSubstitute(entry, variables)]));
}

function nativeRunId(binding) {
  return binding?.activeRunId || null;
}

function activeEntryKey(binding) {
  return String(binding.agentBindingId);
}

function servicePort(bindingId) {
  const digest = crypto.createHash("sha256").update(String(bindingId)).digest();
  return 24_000 + digest.readUInt16BE(0) % 16_000;
}

function statusCode(error) {
  return Number(error?.status || 0);
}

function openCodeSessionIsBusy(snapshot, sessionId, protocol = "v2") {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const entry = protocol === "v1" ? (snapshot.data?.[sessionId] ?? snapshot[sessionId]) : snapshot.data?.[sessionId];
  if (!entry) return false;
  const status = String(
    typeof entry === "string"
      ? entry
      : entry.type || entry.status?.type || entry.status || entry.state || "",
  ).trim().toLowerCase();
  return ["busy", "running", "working", "pending"].includes(status);
}

function openCodeRequestSessionId(request) {
  const match = String(request?.path || "").match(/^\/api\/session\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : "";
}

function normalizedApiRoute(value) {
  if (!value) return null;
  invariant(value && typeof value === "object" && !Array.isArray(value), "AGENT_API_ROUTE_INVALID", "Agent API route 无效", { status: 500, expose: false });
  let parsed;
  try { parsed = new URL(String(value.baseUrl || "")); } catch { /* handled below */ }
  invariant(parsed && ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash, "AGENT_API_ROUTE_INVALID", "Agent API route 无效", { status: 500, expose: false });
  const apiKey = String(value.apiKey || "");
  invariant(apiKey, "AGENT_API_ROUTE_CREDENTIAL_MISSING", "Agent API route 缺少 credential", { status: 409 });
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.search = "";
  return Object.freeze({
    baseUrl: parsed.toString().replace(/\/$/, ""),
    apiKey,
    model: String(value.model || ""),
    providerId: String(value.providerId || ""),
    protocol: String(value.protocol || "auto"),
    remoteReachable: typeof value.remoteReachable === "boolean" ? value.remoteReachable : null,
    targetHost: parsed.hostname,
    targetPort: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
  });
}

function openAiCompatibleBaseUrl(value) {
  const parsed = new URL(String(value || ""));
  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(?:chat\/completions|responses)$/i, "");
  if (!/\/v1$/i.test(pathname)) pathname = `${pathname}/v1`;
  parsed.pathname = pathname.replace(/^\/?/, "/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function apiEnvironment(endpoint, apiKey) {
  return {
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_BASE: endpoint,
    OPENAI_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
}

const PROVIDER_ENVIRONMENT_KEYS = new Set([
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
]);

function providerEnvironmentFile(environment) {
  return `${Object.entries(environment)
    .filter(([key]) => PROVIDER_ENVIRONMENT_KEYS.has(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n")}\n`;
}

function processEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment || {}).filter(([key]) => !PROVIDER_ENVIRONMENT_KEYS.has(key)));
}

function remoteHttpStatus(error) {
  const status = Number(error?.details?.remoteStatus);
  return Number.isSafeInteger(status) ? status : null;
}

function missingHttpCapability(error) {
  return error?.code === "AGENT_HTTP_REQUEST_FAILED" && [404, 405, 501].includes(remoteHttpStatus(error));
}

function agentCacheVersionKey(version) {
  const label = String(version || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
  const digest = crypto.createHash("sha256").update(String(version || "unknown")).digest("hex").slice(0, 12);
  return `${label}-${digest}`;
}

function codexLocalStorageIdentity(codexHome) {
  return crypto.createHash("sha256").update(String(codexHome || "")).digest("hex").slice(0, 32);
}

function commandHelpHasFlag(help, flag) {
  const escaped = String(flag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s,=]|$)`, "m").test(String(help || ""));
}

function isolatedRuntimeFingerprint(agentId, configuration, route, installation = null, agentProfile = null, skillPins = []) {
  // This identifier is part of the current generated configuration contract.
  // Change it whenever that exact configuration shape changes.
  const configurationContract = `2026-08-26.3:${VERSION_HOOK_REVISION}`;
  const credentialDigest = route?.apiKey
    ? crypto.createHash("sha256").update(route.apiKey).digest("hex")
    : null;
  return crypto.createHash("sha256").update(JSON.stringify({
    agentId,
    configurationContract,
    installation: installation ? {
      source: installation.source,
      version: installation.version,
      binaryPath: installation.binaryPath,
    } : null,
    agentProfile,
    skillPins: [...skillPins].map(({ skillId, version, sha256, viewHash }) => ({ skillId, version, sha256, viewHash })).sort((a, b) => a.skillId.localeCompare(b.skillId)),
    configuration,
    route: route ? {
      baseUrl: route.baseUrl,
      model: route.model,
      protocol: route.protocol,
      credentialDigest,
    } : null,
  })).digest("hex");
}

function preparationRequestFingerprint({ agentId, bindingId, runtimeBindingId, configScope, agentSource, nativeProtocol, route }) {
  const credentialDigest = route?.apiKey
    ? crypto.createHash("sha256").update(route.apiKey).digest("hex")
    : null;
  return crypto.createHash("sha256").update(JSON.stringify({
    agentId,
    bindingId,
    runtimeBindingId,
    configScope,
    agentSource: String(agentSource || ""),
    nativeProtocol: String(nativeProtocol || ""),
    route: route ? {
      baseUrl: route.baseUrl,
      model: route.model,
      protocol: route.protocol,
      credentialDigest,
    } : null,
  })).digest("hex");
}

function codexRuntimeConfigArguments(configuration = {}, apiRoute = null, agentProfile = null) {
  const model = String(apiRoute?.model || configuration.model || "").trim();
  const sandboxMode = configuration.sandboxMode === "auto"
    ? (agentProfile?.sandboxStrategy || "danger-full-access")
    : configuration.sandboxMode;
  const contextLimit = Number(configuration.contextLimit);
  const entries = [
    ["model", model || null],
    ["model_provider", apiRoute ? "easywork" : null],
    ["model_auto_compact_token_limit", Number.isSafeInteger(contextLimit) && contextLimit > 0 ? contextLimit : null],
    ["model_reasoning_effort", configuration.reasoningEffort || null],
    ["approval_policy", configuration.approvalPolicy || null],
    ["sandbox_mode", sandboxMode || null],
    ...(apiRoute ? [
      ["model_providers.easywork.name", "EasyWork"],
      ["model_providers.easywork.base_url", openAiCompatibleBaseUrl(apiRoute.baseUrl)],
      ["model_providers.easywork.env_key", "OPENAI_API_KEY"],
      ["model_providers.easywork.wire_api", "responses"],
      ["model_providers.easywork.requires_openai_auth", false],
      ["model_providers.easywork.supports_websockets", false],
    ] : []),
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const tomlValue = (value) => typeof value === "string" ? JSON.stringify(value) : String(value);
  return entries.flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]);
}

function codexThreadRequestParams(params, bypassHookTrust) {
  if (!bypassHookTrust) return params;
  const existing = params?.config && typeof params.config === "object" && !Array.isArray(params.config)
    ? params.config
    : {};
  return {
    ...params,
    config: { ...existing, bypass_hook_trust: true },
  };
}

function codexTurnRequestParams(params, context) {
  const model = String(context.runtimeApiRoute?.model || context.configuration.model || "").trim();
  const effort = String(context.configuration.reasoningEffort || "").trim();
  const cwd = String(context.request.workspace?.path || "").trim();
  return {
    ...params,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function codexSteerWindowClosed(error) {
  const values = [
    error?.message,
    error?.details?.message,
    error?.cause?.message,
    error?.cause?.details?.message,
  ].map((value) => String(value || "").toLocaleLowerCase());
  return values.some((value) => value.includes("no active turn to steer"));
}

function contextUsageWithConfiguredLimit(usage, configuration) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const reportedUsed = Number(usage.used);
  const nativeLimit = Number(usage.limit);
  const nativeRatio = Number(usage.ratio);
  const configuredLimit = Number(configuration?.contextLimit);
  // The Agent control displays the auto-compaction calculation window, not
  // the provider/model hard context capacity reported by usage events.
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : Number.isFinite(nativeLimit) && nativeLimit > 0
      ? nativeLimit
      : null;
  const ratio = Number.isFinite(nativeRatio) && nativeRatio >= 0 && nativeRatio <= 1
    ? nativeRatio
    : null;
  const ratioLimit = Number.isFinite(nativeLimit) && nativeLimit > 0 ? nativeLimit : limit;
  const used = ratio !== null && ratioLimit && (!Number.isFinite(reportedUsed) || reportedUsed < 0 || reportedUsed === 0 && ratio > 0)
    ? Math.round(ratio * ratioLimit)
    : reportedUsed;
  if (!Number.isFinite(used) || used < 0) return structuredClone(usage);
  return {
    ...structuredClone(usage),
    used,
    ...(limit ? {
      limit,
      remaining: Math.max(0, limit - used),
      ratio: Math.min(1, Math.max(0, used / limit)),
    } : {}),
  };
}

function verifiedStoredContextUsage(agentId, usage) {
  if (!usage || typeof usage !== "object") return null;
  if (agentId === "claude-code") return ["claude-code-current-request", "claude-code-context-report"].includes(String(usage.source || "")) ? usage : null;
  if (agentId === "qoder-cn") return ["qoder-cn-current-request", "qoder-cn-context-report"].includes(String(usage.source || "")) ? usage : null;
  return usage;
}

export class AgentRuntimeTransport {
  constructor({
    executor,
    deploymentService,
    skillDeployment = null,
    configurationService = null,
    clock = () => Date.now(),
    httpReadyAttempts = 120,
    httpReadyDelayMs = 250,
    openCodePollIntervalMs = 500,
    openCodeDefaultProtocol = "v2",
  } = {}) {
    invariant(executor && typeof executor.spawn === "function" && typeof executor.exec === "function", "AGENT_RUNTIME_EXECUTOR_REQUIRED", "缺少 Agent runtime executor", {
      status: 500,
      expose: false,
    });
    invariant(deploymentService && typeof deploymentService.resolveRuntime === "function", "AGENT_DEPLOYMENT_SERVICE_REQUIRED", "缺少 Agent deployment service", {
      status: 500,
      expose: false,
    });
    this.executor = executor;
    this.deploymentService = deploymentService;
    this.skillDeployment = skillDeployment;
    this.configurationService = configurationService;
    this.clock = clock;
    this.httpReadyAttempts = httpReadyAttempts;
    this.httpReadyDelayMs = httpReadyDelayMs;
    this.openCodePollIntervalMs = openCodePollIntervalMs;
    invariant(["v1", "v2"].includes(openCodeDefaultProtocol), "AGENT_OPENCODE_PROTOCOL_INVALID", "OpenCode 默认协议无效", { status: 500, expose: false });
    this.openCodeDefaultProtocol = openCodeDefaultProtocol;
    this.active = new Map();
    this.pendingPreparations = new Map();
    this.pendingProcessStarts = new Map();
    this.proxies = new Map();
    this.preparedRuntimeRoots = new Set();
    this.configurationHashes = new Map();
    this.cliCapabilityProfiles = new Map();
    this.claudeEffortFallbacks = new Map();
    this.codexStorageProfiles = new Map();
    this.pendingCodexStorageProfiles = new Map();
    this.nativeProcessActivitySequence = 0;
    this.releaseSessionChannelPressureHandler = typeof this.executor.setSessionChannelPressureHandler === "function"
      ? this.executor.setSessionChannelPressureHandler(() => this.#evictLeastRecentlyUsedIdleNativeProcess())
      : null;
  }

  #touchNativeProcess(entry) {
    if (!entry?.process || entry.process.detached) return;
    entry.lastActiveAt = Number(this.clock());
    entry.lastActiveOrder = ++this.nativeProcessActivitySequence;
  }

  async #evictLeastRecentlyUsedIdleNativeProcess() {
    const candidates = [...this.active.entries()]
      .filter(([, entry]) => {
        const process = entry?.process;
        if (!process || process.closed || process.detached) return false;
        if (entry.agentId === "codex") return !entry.codexFrameScope && entry.operationActive !== true;
        return ["claude-code", "qoder-cn"].includes(entry.agentId) && entry.prepared === true;
      })
      .sort((left, right) => Number(left[1].lastActiveOrder || 0) - Number(right[1].lastActiveOrder || 0));
    const candidate = candidates[0];
    if (!candidate) return false;
    const [key, entry] = candidate;
    const process = entry.process;
    if (this.active.get(key) !== entry) return false;
    this.active.delete(key);
    try {
      if (typeof process.retire === "function") await process.retire();
      else if (typeof process.endInput === "function") process.endInput();
      else if (typeof process.signal === "function") await process.signal("SIGTERM");
      else throw new Error("Agent process cannot be retired");
      return true;
    } catch {
      if (!process.closed && !this.active.has(key)) this.active.set(key, entry);
      return false;
    }
  }

  async checkReadiness(agentId, { source = null, configScope = "default" } = {}) {
    runtimeAgentDefinition(agentId);
    const installation = await this.deploymentService.resolveRuntime(agentId, { source });
    if (agentId === "qoder-cn") {
      const authentication = await this.deploymentService.authenticationStatus(agentId, { force: true });
      invariant(authentication.authenticated, "QODER_LOGIN_REQUIRED", "请先登录 Qoder CN 账号", {
        status: 409,
        details: { agentId, authentication },
      });
      return Object.freeze({ ready: true, agentId, version: installation.version, protocol: "qoder-cn-stream-json", authentication });
    }
    if (agentId !== "codex") {
      return Object.freeze({ ready: true, agentId, version: installation.version, protocol: null });
    }

    const [home, configuration] = await Promise.all([
      this.executor.home(),
      this.configurationService
        ? this.configurationService.runtimeValues(agentId, { configScope })
        : Promise.resolve({}),
    ]);
    const probeHome = `${remoteAgentPaths(home, agentId).easyworkRoot}/runtime/readiness/codex`;
    const probeRuntimeHome = `${probeHome}/home`;
    const prepared = await this.executor.exec(`mkdir -p -- ${shellQuote(probeHome)} ${shellQuote(probeRuntimeHome)}`, { maxOutputBytes: 16 * 1024 });
    invariant(prepared.code === 0, "AGENT_READINESS_PREPARE_FAILED", "无法准备 Codex 就绪检查目录", {
      status: 502,
      retryable: true,
      details: { agentId, exitCode: prepared.code },
    });
    const storageProfile = await this.#codexStorageProfile(probeHome);
    let process = null;
    try {
      process = await this.executor.spawn({
        executable: installation.binaryPath,
        args: ["app-server", ...codexRuntimeConfigArguments(configuration, null, null)],
        cwd: probeRuntimeHome,
        env: {
          HOME: probeRuntimeHome,
          CODEX_HOME: probeHome,
          ...(storageProfile.sqliteHome ? { CODEX_SQLITE_HOME: storageProfile.sqliteHome } : {}),
        },
      });
      await process.requestJsonRpc("initialize", {
        clientInfo: { name: "easywork-readiness", title: "EasyWork", version: "2" },
        capabilities: { experimentalApi: true },
      }, READINESS_RPC_TIMEOUT_MS);
      invariant(typeof process.notifyJsonRpc === "function", "AGENT_CODEX_INITIALIZE_UNSUPPORTED", "Codex process 不支持 initialized notification", {
        status: 409,
      });
      process.notifyJsonRpc("initialized");
      return Object.freeze({
        ready: true,
        agentId,
        version: installation.version,
        protocol: "codex-app-server-jsonrpc",
        storageMode: storageProfile.mode,
        filesystemType: storageProfile.filesystemType,
      });
    } catch (error) {
      throw new ApiError("AGENT_CODEX_PROTOCOL_UNAVAILABLE", `Codex ${String(installation.version || "unknown")} 没有提供 EasyWork 所需的 app-server 初始化协议`, {
        status: 409,
        retryable: Boolean(error?.retryable),
        details: {
          actualVersion: String(installation.version || "unknown"),
          protocol: "codex-app-server-jsonrpc",
          reason: String(error?.code || error?.message || "initialize_failed"),
        },
        cause: error,
      });
    } finally {
      if (process && !process.closed && typeof process.signal === "function") {
        await process.signal("SIGTERM").catch(() => undefined);
      }
    }
  }

  async execute(request) {
    invariant(request && request.descriptor && request.binding, "AGENT_TRANSPORT_REQUEST_INVALID", "Agent transport 请求不完整", { status: 400 });
    const agentId = String(request.adapterId || "");
    runtimeAgentDefinition(agentId);
    if (agentId === "qoder-cn" && !["event-cache", "native-deferred", "native-rewind-deferred"].includes(request.descriptor.transport)) {
      const authentication = await this.deploymentService.authenticationStatus(agentId, { force: true });
      invariant(authentication.authenticated, "QODER_LOGIN_REQUIRED", "请先登录 Qoder CN 账号", {
        status: 409,
        details: { agentId, authentication },
      });
    }
    invariant(request.descriptor.adapter === agentId && request.descriptor.operation === request.operation, "AGENT_TRANSPORT_DESCRIPTOR_MISMATCH", "Agent operation descriptor 与请求不一致", {
      status: 400,
    });
    const bindingId = String(request.binding.agentBindingId || "");
    let nativeStoreBindingId = String(request.binding.native?.runtimeBindingId || bindingId);
    const apiRoute = normalizedApiRoute(request.apiRoute);
    const configScope = String(request.task?.conversationId || "default");
    const requestedSource = request.agentSource || request.binding.native?.agentSource || null;
    const preparationFingerprint = preparationRequestFingerprint({
      agentId,
      bindingId,
      runtimeBindingId: nativeStoreBindingId,
      configScope,
      agentSource: requestedSource,
      nativeProtocol: request.binding.native?.protocol,
      route: apiRoute,
    });
    let activeEntry = this.active.get(activeEntryKey(request.binding));
    let preparedRuntime = ["start", "resume"].includes(request.operation)
      && activeEntry?.agentId === agentId
      && activeEntry.preparedRuntime?.fingerprint === preparationFingerprint
      && Number(this.clock()) - Number(activeEntry.preparedRuntime.preparedAt) <= PREPARED_RUNTIME_TTL_MS
      ? activeEntry.preparedRuntime
      : null;
    if (!preparedRuntime && ["start", "resume"].includes(request.operation)) {
      const pending = this.pendingPreparations.get(`${bindingId}\0${preparationFingerprint}`);
      if (pending) {
        await pending;
        activeEntry = this.active.get(activeEntryKey(request.binding));
        preparedRuntime = activeEntry?.agentId === agentId
          && activeEntry.preparedRuntime?.fingerprint === preparationFingerprint
          ? activeEntry.preparedRuntime
          : null;
      }
    }
    let installation;
    let paths;
    let nativeStorePaths;
    let environment;
    let configuration;
    let agentProfile;
    let runtimeApiRoute;
    let runtimeFingerprint;
    if (preparedRuntime) {
      ({ installation, paths, nativeStorePaths, environment, configuration, agentProfile, runtimeApiRoute, runtimeFingerprint } = preparedRuntime);
      nativeStoreBindingId = String(preparedRuntime.nativeStoreBindingId || nativeStoreBindingId);
      if (preparedRuntime.runtimeProxy) request.__runtimeProxy = structuredClone(preparedRuntime.runtimeProxy);
      // Runtime preparation is scoped by binding, route and conversation
      // configuration. Reuse it across turns until the fingerprint changes.
      preparedRuntime.preparedAt = Number(this.clock());
    } else {
      const [resolvedInstallation, home] = await Promise.all([
        this.deploymentService.resolveRuntime(agentId, { source: requestedSource }),
        this.executor.home(),
      ]);
      installation = resolvedInstallation;
      paths = remoteAgentPaths(home, agentId, bindingId);
      nativeStorePaths = nativeStoreBindingId === bindingId
        ? paths
        : remoteAgentPaths(home, agentId, nativeStoreBindingId);
      const configurationPromise = this.configurationService
        ? this.configurationService.runtimeValues(agentId, { configScope })
        : Promise.resolve({});
      const [, storedConfiguration] = await Promise.all([
        Promise.all([...new Map([paths, nativeStorePaths].map((entry) => [entry.runtimeRoot, entry])).values()]
          .map((entry) => this.#prepareRuntime(entry, agentId, nativeStorePaths))),
        configurationPromise,
      ]);
      if (agentId === "opencode" && nativeStoreBindingId !== bindingId) {
        await this.#detachOpenCodeNativeStore(paths, nativeStorePaths, {
          nativeStoreBindingId,
          installation,
        });
        nativeStoreBindingId = bindingId;
        nativeStorePaths = paths;
      }
      configuration = apiRoute?.model && !storedConfiguration.model
        ? { ...storedConfiguration, model: apiRoute.model }
        : storedConfiguration;
      const agentProfilePromise = agentId === "opencode"
        ? this.#openCodeCliProfile(installation, request.binding)
        : agentId === "codex"
          ? this.#codexCliProfile(installation, configuration)
          : Promise.resolve(null);
      [environment, agentProfile] = await Promise.all([
        request.descriptor.transport === "event-cache"
          ? Promise.resolve(runtimeEnvironment(paths))
          : this.#runtimeEnvironment(request, paths, installation, configuration, apiRoute, nativeStorePaths),
        agentProfilePromise,
      ]);
      runtimeApiRoute = apiRoute
        ? {
            ...apiRoute,
            baseUrl: environment.OPENAI_BASE_URL || apiRoute.baseUrl,
            apiKey: environment.OPENAI_API_KEY || apiRoute.apiKey,
          }
        : null;
      agentProfile = await this.#applyIsolatedConfiguration(
        agentId,
        agentId === "codex" ? nativeStorePaths : paths,
        configuration,
        runtimeApiRoute,
        installation,
        agentProfile,
      );
      runtimeFingerprint = isolatedRuntimeFingerprint(agentId, configuration, runtimeApiRoute, installation, agentProfile);
    }
    // A context-usage event-cache probe can run against a warmed Codex entry
    // between preparation and formal Task start. Treat the native store path
    // as authoritative before caching or execution so that logical-only probe
    // environment can never move a forked thread to branch-local CODEX_HOME.
    if (agentId === "codex") {
      const storageProfile = await this.#codexStorageProfile(`${nativeStorePaths.runtimeData}/codex`);
      environment = Object.freeze({
        ...environment,
        CODEX_HOME: `${nativeStorePaths.runtimeData}/codex`,
        ...(storageProfile.sqliteHome ? { CODEX_SQLITE_HOME: storageProfile.sqliteHome } : {}),
      });
    } else if (agentId === "opencode") {
      environment = Object.freeze({
        ...environment,
        XDG_DATA_HOME: nativeStorePaths.runtimeData,
      });
    }
    await restoreSkillSnapshot(this.executor, paths, request.binding.native?.skillSnapshot);
    const currentView = await readSkillView(this.executor, paths);
    const inheritedPins = [...new Map([...(request.binding.native?.skillPins || []), ...(request.recoveredSkillPins || [])].map((pin) => [pin.skillId, pin])).values()];
    const missingPins = inheritedPins.filter((pin) => !currentView.skills.some((item) => item.skillId === pin.skillId && item.sha256 === pin.sha256));
    const recoveredSkillRefs = missingPins.length ? await this.skillDeployment.ensurePins(missingPins) : [];
    // Only a verified native-session replacement supplies recovered pins.  It
    // rebuilds the old session's discoverable capabilities without copying a
    // Skill body into the user prompt.
    const recoveredSkills = await this.#bindSkillView(recoveredSkillRefs, paths);
    const deployedSkills = request.skills && !Array.isArray(request.skills)
      ? await this.#deploySkills(request.skills, paths)
      : await this.#bindSkillView(request.skills || [], paths);
    const skills = assertEasyWorkSkillPaths(
      deployedSkills,
      paths.skillsRoot,
    );
    const skillPins = [...new Map([...currentView.skills, ...recoveredSkills, ...skills].map((skill) => [skill.skillId, skill])).values()];
    const nativeSkillCommand = ["claude-code", "qoder-cn", "opencode"].includes(agentId) && ["start", "resume"].includes(request.operation)
      ? await selectedSkillCommand(this.executor, paths, skills) : null;
    runtimeFingerprint = isolatedRuntimeFingerprint(agentId, configuration, runtimeApiRoute, installation, agentProfile, skillPins);
    if (nativeSkillCommand) runtimeFingerprint = crypto.createHash("sha256").update(runtimeFingerprint).update(nativeSkillCommand.sha256).digest("hex");
    const context = {
      request,
      agentId,
      bindingId,
      nativeStoreBindingId,
      configScope,
      installation,
      paths,
      nativeStorePaths,
      skills,
      nativeSkillCommand,
      environment,
      configuration,
      agentProfile,
      apiRoute,
      runtimeApiRoute,
      runtimeFingerprint,
      effortAdjustments: [],
      releaseEffortAdaptationHandler: null,
    };
    if (agentId !== "qoder-cn"
      && ["start", "resume"].includes(request.operation)
      && (request.task?.route?.providerId || request.task?.route?.modelId)) {
      invariant(runtimeApiRoute, "AGENT_API_ROUTE_REQUIRED", "当前 Agent 会话没有可用的模型 API 配置", {
        status: 409,
        details: { agentId, operation: request.operation },
      });
    }
    if (["start", "resume", "append"].includes(request.operation)) {
      const taskId = String(request.task?.id || "");
      invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(taskId), "AGENT_VERSION_TASK_ID_INVALID", "Agent 文件版本 Hook 缺少当前 Task", { status: 500, expose: false });
      const activeHookPaths = versionHookPaths(agentId === "codex" ? nativeStorePaths : paths);
      await this.#writeConfigurationIfChanged(activeHookPaths.activeTask, `${taskId}\n`, { mode: 0o600 });
      if (agentId === "codex") {
        const nativeSessionId = request.binding.native?.threadId || request.binding.state?.sessionId || null;
        if (nativeSessionId) await this.#bindCodexVersionTask(context, nativeSessionId);
      }
    }

    this.#bindEffortAdaptationHandler(context);
    let result;
    try {
      if (request.descriptor.transport === "event-cache") {
        const storedUsage = verifiedStoredContextUsage(agentId, request.binding.state?.contextUsage);
        const cachedUsage = contextUsageWithConfiguredLimit(storedUsage, configuration);
        result = {
          runId: nativeRunId(request.binding),
          bindingPatch: {
            native: {
              agentSource: installation.source,
              binaryPath: installation.binaryPath,
              runtimeRoot: paths.runtimeRoot,
              runtimeBindingId: nativeStoreBindingId,
              runtimeStoreRoot: nativeStorePaths.runtimeRoot,
            },
          },
          contextUsage: cachedUsage,
          contextUsageReason: cachedUsage ? null : "当前原生会话尚未返回可验证的上下文用量；运行一次 Agent 后再读取。",
        };
      } else if (request.descriptor.transport === "native-deferred") {
        invariant(["claude-code", "qoder-cn"].includes(agentId), "AGENT_NATIVE_DEFERRED_UNSUPPORTED", `${agentId} 不支持 deferred native operation`, { status: 409 });
        const sourceSessionId = String(request.descriptor.sourceSessionId || "");
        const targetSessionId = String(request.descriptor.targetSessionId || "");
        const resumeSessionAt = String(request.descriptor.resumeSessionAt || "");
        invariant(sourceSessionId && targetSessionId && resumeSessionAt, "AGENT_NATIVE_FORK_BOUNDARY_MISSING", `${agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 原生分支缺少会话边界`, { status: 409 });
        invariant(await nativeTranscriptHasAssistantBoundary({
          executor: this.executor,
          runtimeData: nativeStorePaths.runtimeData,
          sessionId: sourceSessionId,
          turnId: resumeSessionAt,
          configDirectory: agentId === "qoder-cn" ? "qoder-cn" : "claude",
        }), "AGENT_NATIVE_FORK_BOUNDARY_INVALID", `${agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 原生分支边界已失效`, {
          status: 409,
          details: { sessionId: sourceSessionId, resumeSessionAt },
        });
        await this.#recordRuntime(context, {
          runId: nativeRunId(request.binding),
          status: "idle",
          sessionId: targetSessionId,
        });
        result = {
          runId: nativeRunId(request.binding),
          bindingPatch: {
            state: { sessionId: targetSessionId, turnId: null, status: "idle" },
            native: {
              agentSource: installation.source,
              binaryPath: installation.binaryPath,
              runtimeRoot: paths.runtimeRoot,
              runtimeBindingId: nativeStoreBindingId,
              runtimeStoreRoot: nativeStorePaths.runtimeRoot,
              skillsRoot: paths.skillsRoot,
              sessionId: targetSessionId,
              turnId: null,
              pendingFork: { sourceSessionId, targetSessionId, resumeSessionAt },
            },
          },
        };
      } else if (request.descriptor.transport === "native-rewind-deferred") {
        invariant(["claude-code", "qoder-cn"].includes(agentId), "AGENT_NATIVE_REWIND_DEFERRED_UNSUPPORTED", `${agentId} 不支持 deferred native rewind`, { status: 409 });
        const sessionId = String(request.descriptor.sessionId || "");
        const resumeSessionAt = String(request.descriptor.resumeSessionAt || "");
        const resumeDropsTurn = String(request.descriptor.resumeDropsTurn || "");
        invariant(sessionId && resumeSessionAt, "AGENT_NATIVE_REWIND_BOUNDARY_MISSING", `${agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 原生回退缺少会话边界`, { status: 409 });
        invariant(await nativeTranscriptHasAssistantBoundary({
          executor: this.executor,
          runtimeData: nativeStorePaths.runtimeData,
          sessionId,
          turnId: resumeSessionAt,
          configDirectory: agentId === "qoder-cn" ? "qoder-cn" : "claude",
        }), "AGENT_NATIVE_REWIND_BOUNDARY_INVALID", `${agentId === "qoder-cn" ? "Qoder CN" : "Claude Code"} 原生回退边界已失效`, {
          status: 409,
          details: { sessionId, resumeSessionAt },
        });
        await this.#recordRuntime(context, {
          runId: nativeRunId(request.binding),
          status: "idle",
          sessionId,
        });
        result = {
          runId: nativeRunId(request.binding),
          bindingPatch: {
            state: { sessionId, turnId: resumeSessionAt, status: "idle" },
            native: {
              agentSource: installation.source,
              binaryPath: installation.binaryPath,
              runtimeRoot: paths.runtimeRoot,
              runtimeBindingId: nativeStoreBindingId,
              runtimeStoreRoot: nativeStorePaths.runtimeRoot,
              skillsRoot: paths.skillsRoot,
              sessionId,
              turnId: resumeSessionAt,
              pendingFork: null,
              pendingRewind: {
                sessionId,
                resumeSessionAt,
                ...(resumeDropsTurn ? { resumeDropsTurn } : {}),
              },
            },
          },
        };
      } else if (agentId === "opencode") {
        result = await this.#executeOpenCode(context);
      } else if (agentId === "codex") {
        result = await this.#executeCodex(context);
      } else if (agentId === "claude-code") {
        result = await this.#executeClaudeCode(context);
      } else if (agentId === "qoder-cn") {
        result = await this.#executeClaudeCode(context);
      } else {
        context.releaseEffortAdaptationHandler?.();
        return unsupportedCapability(agentId, request.operation, "no_transport");
      }
    } catch (error) {
      const failedEntry = this.active.get(activeEntryKey(request.binding));
      if (failedEntry?.agentId === "codex" && failedEntry.operationActive === true) {
        failedEntry.operationActive = false;
        this.#touchNativeProcess(failedEntry);
      }
      context.releaseEffortAdaptationHandler?.();
      throw error;
    }
    if (result?.frames) {
      result = {
        ...result,
        frames: framesWithEffortAdjustments(result.frames, {
          queue: context.effortAdjustments,
          agentId,
          agentVersion: installation.version,
          release: context.releaseEffortAdaptationHandler,
        }),
      };
    } else {
      context.releaseEffortAdaptationHandler?.();
    }
    const warmedEntry = this.active.get(activeEntryKey(request.binding));
    // event-cache only reads already persisted native context usage. It does
    // not materialize the Provider environment and therefore its
    // runtimeApiRoute still names the host-side upstream. Never let that
    // read-only probe replace the executable preparation established by
    // prepare/fork/start, or the next native turn can bypass the SSH relay.
    if (warmedEntry?.agentId === agentId && request.descriptor.transport !== "event-cache") {
      warmedEntry.preparedRuntime = {
        fingerprint: preparationFingerprint,
        preparedAt: Number(this.clock()),
        nativeStoreBindingId,
        installation,
        paths,
        nativeStorePaths,
        environment,
        configuration,
        agentProfile,
        runtimeApiRoute,
        runtimeFingerprint,
        runtimeProxy: request.__runtimeProxy ? structuredClone(request.__runtimeProxy) : null,
      };
    }
    const knownSkills = new Map((Array.isArray(request.binding?.native?.skillPins) ? request.binding.native.skillPins : [])
      .map((entry) => [String(entry.skillId), entry]));
    for (const skill of skillPins) {
      knownSkills.set(String(skill.skillId), {
        skillId: String(skill.skillId),
        version: String(skill.version),
        sha256: String(skill.sha256),
        ...(skill.viewHash ? { viewHash: skill.viewHash } : {}),
        ...(skill.nativeName ? { nativeName: skill.nativeName } : {}),
      });
    }
    return {
      ...result,
      bindingPatch: {
        ...(result.bindingPatch || {}),
        native: {
          ...(result.bindingPatch?.native || {}),
          skillPins: [...knownSkills.values()],
          ...(["start", "resume"].includes(request.operation) ? {
            skillSnapshotRequiredFrom: request.binding.native?.skillSnapshotRequiredFrom || request.task.createdAt,
          } : {}),
        },
      },
    };
  }

  async prepare(request) {
    invariant(request?.task?.route && request?.binding, "AGENT_PREPARE_REQUEST_INVALID", "Agent 预备请求不完整", { status: 400 });
    const agentId = String(request.adapterId || request.task.route.agentId || "");
    runtimeAgentDefinition(agentId);
    const bindingId = String(request.binding.agentBindingId || "");
    invariant(bindingId, "AGENT_BINDING_REQUIRED", "Agent 预备请求缺少 binding", { status: 400 });
    const nativeStoreBindingId = String(request.binding.native?.runtimeBindingId || bindingId);
    const apiRoute = normalizedApiRoute(request.apiRoute);
    const configScope = String(request.task.conversationId || "default");
    const requestedSource = request.agentSource || request.binding.native?.agentSource || null;
    const fingerprint = preparationRequestFingerprint({
      agentId,
      bindingId,
      runtimeBindingId: nativeStoreBindingId,
      configScope,
      agentSource: requestedSource,
      nativeProtocol: request.binding.native?.protocol,
      route: apiRoute,
    });
    const activeEntry = this.active.get(activeEntryKey(request.binding));
    const cached = activeEntry?.preparedRuntime;
    if (activeEntry?.agentId === agentId
      && cached?.fingerprint === fingerprint
      && Number(this.clock()) - Number(cached.preparedAt) <= PREPARED_RUNTIME_TTL_MS) {
      return Object.freeze({
        prepared: true,
        agentId,
        bindingId,
        native: Object.freeze({
          agentSource: cached.installation.source,
          binaryPath: cached.installation.binaryPath,
          runtimeRoot: cached.paths.runtimeRoot,
          runtimeBindingId: String(cached.nativeStoreBindingId || nativeStoreBindingId),
          runtimeStoreRoot: cached.nativeStorePaths.runtimeRoot,
          skillsRoot: cached.paths.skillsRoot,
          processId: activeEntry.process?.processId || null,
          servicePort: Number.isSafeInteger(activeEntry.servicePort) ? activeEntry.servicePort : null,
          runtimeFingerprint: cached.runtimeFingerprint,
        }),
      });
    }
    const pendingKey = `${bindingId}\0${fingerprint}`;
    const pending = this.pendingPreparations.get(pendingKey);
    if (pending) return pending;
    const run = this.#prepare(request);
    this.pendingPreparations.set(pendingKey, run);
    try { return await run; }
    finally { if (this.pendingPreparations.get(pendingKey) === run) this.pendingPreparations.delete(pendingKey); }
  }

  async captureSkillSnapshot({ task, binding }) {
    if (!binding?.native?.runtimeRoot) return null;
    const paths = remoteAgentPaths(await this.executor.home(), binding.adapterId, binding.agentBindingId);
    const manifest = await readSkillView(this.executor, paths);
    return captureSkillSnapshot(this.executor, paths, task.id, manifest.skills.map(({ skillId, version, sha256, nativeName, viewHash }) => ({ skillId, version, sha256, nativeName, viewHash })));
  }

  async #prepare(request) {
    invariant(request?.task?.route && request?.binding, "AGENT_PREPARE_REQUEST_INVALID", "Agent 预备请求不完整", { status: 400 });
    const agentId = String(request.adapterId || request.task.route.agentId || "");
    runtimeAgentDefinition(agentId);
    if (agentId === "qoder-cn") {
      const authentication = await this.deploymentService.authenticationStatus(agentId, { force: true });
      invariant(authentication.authenticated, "QODER_LOGIN_REQUIRED", "请先登录 Qoder CN 账号", {
        status: 409,
        details: { agentId, authentication },
      });
    }
    const bindingId = String(request.binding.agentBindingId || "");
    invariant(bindingId, "AGENT_BINDING_REQUIRED", "Agent 预备请求缺少 binding", { status: 400 });
    const requestedNativeStoreBindingId = String(request.binding.native?.runtimeBindingId || bindingId);
    let nativeStoreBindingId = requestedNativeStoreBindingId;
    const [installation, home] = await Promise.all([
      this.deploymentService.resolveRuntime(agentId, {
        source: request.agentSource || request.binding.native?.agentSource || null,
      }),
      this.executor.home(),
    ]);
    const paths = remoteAgentPaths(home, agentId, bindingId);
    let nativeStorePaths = nativeStoreBindingId === bindingId
      ? paths
      : remoteAgentPaths(home, agentId, nativeStoreBindingId);
    const apiRoute = normalizedApiRoute(request.apiRoute);
    const configScope = String(request.task.conversationId || "default");
    const configurationPromise = this.configurationService
      ? this.configurationService.runtimeValues(agentId, { configScope })
      : Promise.resolve({});
    const [, storedConfiguration] = await Promise.all([
      Promise.all([...new Map([paths, nativeStorePaths].map((entry) => [entry.runtimeRoot, entry])).values()]
        .map((entry) => this.#prepareRuntime(entry, agentId, nativeStorePaths))),
      configurationPromise,
    ]);
    if (agentId === "opencode" && nativeStoreBindingId !== bindingId) {
      await this.#detachOpenCodeNativeStore(paths, nativeStorePaths, {
        nativeStoreBindingId,
        installation,
      });
      nativeStoreBindingId = bindingId;
      nativeStorePaths = paths;
    }
    const configuration = apiRoute?.model && !storedConfiguration.model
      ? { ...storedConfiguration, model: apiRoute.model }
      : storedConfiguration;
    let [environment, discoveredAgentProfile] = await Promise.all([
      this.#runtimeEnvironment(request, paths, installation, configuration, apiRoute, nativeStorePaths),
      agentId === "opencode"
        ? this.#openCodeCliProfile(installation, request.binding)
        : agentId === "codex"
          ? this.#codexCliProfile(installation, configuration)
        : Promise.resolve(null),
    ]);
    if (agentId === "codex") {
      const storageProfile = await this.#codexStorageProfile(`${nativeStorePaths.runtimeData}/codex`);
      environment = Object.freeze({
        ...environment,
        CODEX_HOME: `${nativeStorePaths.runtimeData}/codex`,
        ...(storageProfile.sqliteHome ? { CODEX_SQLITE_HOME: storageProfile.sqliteHome } : {}),
      });
    }
    const runtimeApiRoute = apiRoute
      ? {
          ...apiRoute,
          baseUrl: environment.OPENAI_BASE_URL || apiRoute.baseUrl,
          apiKey: environment.OPENAI_API_KEY || apiRoute.apiKey,
        }
      : null;
    const agentProfile = await this.#applyIsolatedConfiguration(
      agentId,
      agentId === "codex" ? nativeStorePaths : paths,
      configuration,
      runtimeApiRoute,
      installation,
      discoveredAgentProfile,
    );
    const runtimeFingerprint = isolatedRuntimeFingerprint(agentId, configuration, runtimeApiRoute, installation, agentProfile, request.binding.native?.skillPins || []);
    const sessionId = request.binding.native?.sessionId || request.binding.state?.sessionId || null;
    const descriptor = {
      transport: ["claude-code", "qoder-cn"].includes(agentId) ? "process-jsonl" : agentId === "codex" ? "json-rpc" : "http",
      cwd: request.workspace?.path,
      ...(["claude-code", "qoder-cn"].includes(agentId) ? {
        executable: installation.binaryPath,
        args: [
          agentId === "qoder-cn" ? "--print" : "-p", "--input-format", "stream-json", "--output-format", "stream-json",
          ...(agentId === "claude-code" ? ["--verbose"] : []), "--include-partial-messages", "--permission-prompt-tool", "stdio",
          ...(sessionId ? ["--resume", String(sessionId)] : []),
        ],
        stdin: [],
      } : {}),
    };
    const context = {
      request: { ...request, operation: "prepare", descriptor },
      agentId,
      bindingId,
      nativeStoreBindingId,
      configScope,
      installation,
      paths,
      nativeStorePaths,
      skills: [],
      environment,
      configuration,
      agentProfile,
      apiRoute,
      runtimeApiRoute,
      runtimeFingerprint,
    };
    let entry = null;
    // A draft/branch warm-up can begin before its Agent provider selection has
    // reached the prepared route.  Materialize the isolated runtime in that
    // case, but never start a native process without the exact API route that
    // its first real turn will use.  Otherwise the later turn can inherit a
    // process whose generated config names an API key that was never exported.
    const warmNativeProcess = (runtimeApiRoute || agentId === "qoder-cn") && !request.task.skillPins?.length;
    if (warmNativeProcess && agentId === "opencode") entry = await this.#openCodeService(context);
    else if (warmNativeProcess && agentId === "codex") entry = await this.#codexProcess(context);
    else if (warmNativeProcess && !request.binding.native?.pendingFork && !request.binding.native?.pendingRewind) {
      entry = await this.#claudeProcess(context);
      entry.prepared = true;
    }
    if (entry) {
      entry.preparedRuntime = {
        fingerprint: preparationRequestFingerprint({
          agentId,
          bindingId,
          runtimeBindingId: requestedNativeStoreBindingId,
          configScope,
          agentSource: request.agentSource || request.binding.native?.agentSource || null,
          nativeProtocol: request.binding.native?.protocol,
          route: apiRoute,
        }),
        preparedAt: Number(this.clock()),
        nativeStoreBindingId,
        installation,
        paths,
        nativeStorePaths,
        environment,
        configuration,
        agentProfile,
        runtimeApiRoute,
        runtimeFingerprint,
        runtimeProxy: request.__runtimeProxy ? structuredClone(request.__runtimeProxy) : null,
      };
    }
    return Object.freeze({
      prepared: true,
      agentId,
      bindingId,
      native: Object.freeze({
        agentSource: installation.source,
        binaryPath: installation.binaryPath,
        runtimeRoot: paths.runtimeRoot,
        runtimeBindingId: nativeStoreBindingId,
        runtimeStoreRoot: nativeStorePaths.runtimeRoot,
        skillsRoot: paths.skillsRoot,
        processId: entry?.process?.processId || null,
        servicePort: Number.isSafeInteger(entry?.servicePort) ? entry.servicePort : null,
        runtimeFingerprint,
      }),
    });
  }

  async releaseBinding(bindingId) {
    const key = assertRuntimeIdentifier(bindingId, "agentBindingId");
    const entry = this.active.get(key) || null;
    const hadProxy = this.proxies.has(key);
    this.active.delete(key);
    const results = await Promise.allSettled([
      entry?.process && !entry.process.closed && typeof entry.process.signal === "function"
        ? entry.process.signal("SIGTERM")
        : Promise.resolve(),
      this.#releaseProxy(key),
    ]);
    return Object.freeze({
      bindingId: key,
      releasedProcess: Boolean(entry?.process),
      releasedProxy: hadProxy && results[1]?.status === "fulfilled",
    });
  }

  async close() {
    this.releaseSessionChannelPressureHandler?.();
    this.releaseSessionChannelPressureHandler = null;
    const processes = [...this.active.values()].map((entry) => entry?.process).filter((process) => process && !process.closed);
    this.active.clear();
    await Promise.allSettled(processes.map(async (process) => {
      if (typeof process.signal === "function") await process.signal("SIGTERM");
    }));
    await Promise.allSettled([...this.proxies.keys()].map((bindingId) => this.#releaseProxy(bindingId)));
    this.preparedRuntimeRoots.clear();
    this.configurationHashes.clear();
    this.pendingProcessStarts.clear();
    this.claudeEffortFallbacks.clear();
    this.codexStorageProfiles.clear();
    this.pendingCodexStorageProfiles.clear();
  }

  async refreshManagedConfiguration(agentId, { configScope = "default" } = {}) {
    runtimeAgentDefinition(agentId);
    invariant(this.configurationService && typeof this.configurationService.runtimeValues === "function", "AGENT_CONFIG_UNAVAILABLE", "远端 Agent 配置能力不可用", { status: 503 });
    const configuration = await this.configurationService.runtimeValues(agentId, { configScope });
    const entries = [...this.active.values()].filter((entry) => entry?.agentId === agentId && entry?.configScope === configScope && entry.paths);
    await Promise.all(entries.map(async (entry) => {
      const agentProfile = agentId === "opencode"
        ? await this.#openCodeCliProfile(entry.installation, {
            native: { sessionId: "active", protocol: entry.protocol },
          })
        : null;
      entry.agentProfile = await this.#applyIsolatedConfiguration(
        agentId,
        agentId === "codex" ? entry.nativeStorePaths || entry.paths : entry.paths,
        configuration,
        entry.runtimeApiRoute || null,
        entry.installation || null,
        agentProfile,
      );
      entry.preparedRuntime = null;
    }));
    return Object.freeze({ agentId, ...(configScope === "default" ? {} : { configScope }), updatedBindings: entries.length });
  }

  async stageFiles({ adapterId, bindingId, messageId, files = [] } = {}) {
    const agentId = String(adapterId || "");
    runtimeAgentDefinition(agentId);
    const safeBindingId = assertRuntimeIdentifier(bindingId, "agentBindingId");
    const safeMessageId = assertRuntimeIdentifier(messageId, "messageId");
    invariant(Array.isArray(files) && files.length <= 256, "AGENT_FILE_SELECTION_INVALID", "远端 Agent 文件选择无效", { status: 400 });
    if (!files.length) return [];
    const home = await this.executor.home();
    const paths = remoteAgentPaths(home, agentId, safeBindingId);
    await this.#prepareRuntime(paths, agentId);
    const results = [];
    const names = new Set();
    for (const file of files) {
      const filename = String(file?.filename || "").normalize("NFKC").trim();
      const sha256 = String(file?.sha256 || "").toLowerCase();
      const size = Number(file?.size);
      const localPath = String(file?.localPath || "");
      invariant(filename && filename !== "." && filename !== ".." && !/[\\/\0]/u.test(filename), "AGENT_FILE_NAME_INVALID", "远端 Agent 文件名无效", { status: 400 });
      invariant(!names.has(filename), "AGENT_FILE_NAME_CONFLICT", "本轮选择了多个同名文件，请只保留一个版本", { status: 409, details: { filename } });
      names.add(filename);
      invariant(/^[a-f0-9]{64}$/u.test(sha256), "AGENT_FILE_HASH_INVALID", "远端 Agent 文件摘要无效", { status: 400 });
      invariant(Number.isSafeInteger(size) && size >= 0, "AGENT_FILE_SIZE_INVALID", "远端 Agent 文件大小无效", { status: 400 });
      invariant(path.isAbsolute(localPath), "AGENT_FILE_SOURCE_INVALID", "远端 Agent 文件来源无效", { status: 500, expose: false });
      invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(String(file.resourceVersionId || "")), "AGENT_FILE_RESOURCE_VERSION_INVALID", "远端 Agent 文件版本无效", { status: 500, expose: false });
      const objectRoot = `${paths.filesRoot}/objects/${sha256}`;
      const objectPath = `${objectRoot}/${filename}`;
      const turnRoot = `${paths.filesRoot}/turns/${safeMessageId}`;
      const turnPath = `${turnRoot}/${filename}`;
      const preparedObjectRoot = await this.executor.exec([
        `mkdir -p -- ${shellQuote(objectRoot)}`,
        `chmod 0700 -- ${shellQuote(paths.filesRoot)} ${shellQuote(`${paths.filesRoot}/objects`)} ${shellQuote(objectRoot)}`,
      ].join(" && "), { maxOutputBytes: 2048 });
      invariant(preparedObjectRoot.code === 0, "AGENT_FILE_DIRECTORY_FAILED", "无法准备远端 Agent 文件目录", { status: 502, retryable: true });
      const existing = await this.executor.exec([
        `if [ -f ${shellQuote(objectPath)} ] && [ "$(stat -c '%s' -- ${shellQuote(objectPath)})" = ${shellQuote(String(size))} ] && [ "$(sha256sum -- ${shellQuote(objectPath)} | cut -d' ' -f1)" = ${shellQuote(sha256)} ]; then printf ready; fi`,
      ].join("; "), { maxOutputBytes: 1024 });
      if (String(existing.stdout || "").trim() !== "ready") {
        const temporaryObject = `${objectRoot}/.upload-${crypto.randomUUID()}`;
        try {
          await this.executor.upload(localPath, temporaryObject);
          const verified = await this.executor.exec([
            `test -f ${shellQuote(temporaryObject)}`,
            `test "$(stat -c '%s' -- ${shellQuote(temporaryObject)})" = ${shellQuote(String(size))}`,
            `test "$(sha256sum -- ${shellQuote(temporaryObject)} | cut -d' ' -f1)" = ${shellQuote(sha256)}`,
            `chmod 0400 -- ${shellQuote(temporaryObject)}`,
            `mv -Tf -- ${shellQuote(temporaryObject)} ${shellQuote(objectPath)}`,
          ].join(" && "), { maxOutputBytes: 2048 });
          invariant(verified.code === 0, "AGENT_FILE_STAGE_VERIFY_FAILED", "远端 Agent 文件校验失败", { status: 502, retryable: true });
        } catch (error) {
          await this.executor.exec(`rm -f -- ${shellQuote(temporaryObject)}`, { maxOutputBytes: 1024 }).catch(() => undefined);
          throw error;
        }
      }
      const temporaryLink = `${turnRoot}/.file-${crypto.randomUUID()}`;
      const linked = await this.executor.exec([
        `mkdir -p -- ${shellQuote(turnRoot)}`,
        `chmod 0700 -- ${shellQuote(paths.filesRoot)} ${shellQuote(objectRoot)} ${shellQuote(turnRoot)}`,
        `ln -- ${shellQuote(objectPath)} ${shellQuote(temporaryLink)}`,
        `mv -Tf -- ${shellQuote(temporaryLink)} ${shellQuote(turnPath)}`,
      ].join(" && "), { maxOutputBytes: 2048 });
      invariant(linked.code === 0, "AGENT_FILE_VIEW_FAILED", "无法建立本轮远端 Agent 文件视图", { status: 502, retryable: true });
      results.push(Object.freeze({
        resourceVersionId: String(file.resourceVersionId),
        filename,
        sha256,
        size,
        remotePath: turnPath,
      }));
    }
    return results;
  }

  async #deploySkills(plan, paths) {
    invariant(this.skillDeployment && typeof this.skillDeployment.ensure === "function", "AGENT_SKILL_DEPLOYMENT_UNAVAILABLE", "远端 Skill 部署能力不可用", { status: 503, retryable: true });
    const cached = await this.skillDeployment.ensure(plan);
    return this.#bindSkillView(cached, paths);
  }

  async #bindSkillView(refs, paths) {
    const cached = assertEasyWorkSkillPaths(refs, paths.skillCacheRoot);
    if (!cached.length) return [];
    const unique = [...new Map(cached.map((entry) => [entry.skillId, entry])).values()];
    const manifestPath = `${paths.runtimeState}/skill-view.json`;
    let manifest = { schemaVersion: 1, skills: [] };
    try { manifest = JSON.parse((await this.executor.readFile(manifestPath)).toString("utf8")); }
    catch (error) { if (!["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code)) throw error; }
    const results = [];
    for (const entry of unique) {
      const previous = manifest.skills.find((skill) => skill.skillId === entry.skillId && skill.sha256 === entry.sha256);
      if (previous) { results.push({ ...previous, remotePath: `${paths.skillsRoot}/${entry.skillId}` }); continue; }
      const descriptor = JSON.parse((await this.executor.readFile(`${entry.remotePath}/package.json`)).toString("utf8"));
      invariant(descriptor.sha256 === entry.sha256 && Array.isArray(descriptor.files), "AGENT_SKILL_PACKAGE_INVALID", "当前技能包缺少固定内容清单", { status: 409 });
      const files = await Promise.all(descriptor.files.map(async (file) => ({ path: file.path, content: await this.executor.readFile(`${entry.remotePath}/${file.path}`) })));
      const normalized = normalizeNativeSkillFiles({ skillId: entry.skillId, ...descriptor.manifest, files });
      const document = normalized.find((file) => file.path === "SKILL.md");
      const { metadata } = parseNativeSkill(document.content);
      invariant(!manifest.skills.some((skill) => skill.skillId !== entry.skillId && skill.nativeName === metadata.name), "AGENT_SKILL_NAME_CONFLICT", "当前对话的技能原生名称冲突", { status: 409 });
      const viewHash = crypto.createHash("sha256").update(entry.sha256).update(document.content).digest("hex");
      const ownedRoot = `${paths.runtimeRoot}/skill-generations/${crypto.randomUUID()}/${entry.skillId}`;
      const copied = await this.executor.exec(`mkdir -p -- ${shellQuote(ownedRoot)} && cp -a --reflink=auto -- ${shellQuote(`${entry.remotePath}/.`)} ${shellQuote(ownedRoot)}`, { maxOutputBytes: 2048 });
      invariant(copied.code === 0, "AGENT_SKILL_VIEW_FAILED", "无法复制当前对话的技能文件", { status: 502 });
      await this.executor.writeAtomic(`${ownedRoot}/SKILL.md`, document.content, { mode: 0o600 });
      const viewPath = `${paths.skillsRoot}/${entry.skillId}`;
      const temporaryLink = `${paths.skillsRoot}/.link-${crypto.randomUUID()}`;
      const linked = await this.executor.exec(`ln -s -- ${shellQuote(ownedRoot)} ${shellQuote(temporaryLink)} && mv -Tf -- ${shellQuote(temporaryLink)} ${shellQuote(viewPath)}`, { maxOutputBytes: 2048 });
      invariant(linked.code === 0, "AGENT_SKILL_VIEW_FAILED", "无法切换当前对话的技能代次", { status: 502 });
      const record = { ...entry, nativeName: metadata.name, viewHash, ownedRoot, remotePath: viewPath };
      manifest.skills = [...manifest.skills.filter((skill) => skill.skillId !== entry.skillId), record];
      await this.executor.writeAtomic(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      results.push(record);
    }
    return results;
  }

  async #codexStorageProfile(codexHome) {
    const normalizedHome = path.posix.normalize(String(codexHome || ""));
    invariant(normalizedHome.startsWith("/") && normalizedHome !== "/", "AGENT_CODEX_HOME_INVALID", "Codex runtime 目录无效", {
      status: 500,
      expose: false,
    });
    const cached = this.codexStorageProfiles.get(normalizedHome);
    if (cached) return cached;
    const pending = this.pendingCodexStorageProfiles.get(normalizedHome);
    if (pending) return pending;
    const run = this.#resolveCodexStorageProfile(normalizedHome);
    this.pendingCodexStorageProfiles.set(normalizedHome, run);
    try {
      const profile = await run;
      this.codexStorageProfiles.set(normalizedHome, profile);
      return profile;
    } finally {
      if (this.pendingCodexStorageProfiles.get(normalizedHome) === run) {
        this.pendingCodexStorageProfiles.delete(normalizedHome);
      }
    }
  }

  async #resolveCodexStorageProfile(codexHome) {
    const identity = codexLocalStorageIdentity(codexHome);
    const command = `
set -eu
codex_home=${shellQuote(codexHome)}
mkdir -p -- "$codex_home/tmp"
fs_type="$(stat -f -c %T -- "$codex_home" 2>/dev/null || printf '%s' unknown)"
case "$fs_type" in
  ext2/ext3|ext4|xfs|btrfs|tmpfs|overlayfs|zfs|f2fs|jfs|reiserfs|ufs|ramfs)
    printf '%s\\tpersistent\\t\\t%s\\n' '${CODEX_STORAGE_PROBE_MARKER}' "$fs_type"
    ;;
  *)
    tmp_type="$(stat -f -c %T -- /tmp 2>/dev/null || printf '%s' unknown)"
    case "$tmp_type" in
      ext2/ext3|ext4|xfs|btrfs|tmpfs|overlayfs|zfs|f2fs|jfs|reiserfs|ufs|ramfs) ;;
      *)
        printf '%s\\tpersistent\\t\\t%s\\n' '${CODEX_STORAGE_PROBE_MARKER}' "$fs_type"
        exit 0
        ;;
    esac
    uid="$(id -u)"
    user_root="/tmp/easywork-$uid"
    family_root="$user_root/codex"
    local_root="$family_root/${identity}"
    sqlite_home="$local_root/sqlite"
    arg0_home="$local_root/arg0"
    for target in "$user_root" "$family_root" "$local_root" "$sqlite_home" "$arg0_home"; do
      [ ! -L "$target" ] || exit 73
    done
    mkdir -p -- "$sqlite_home" "$arg0_home"
    for target in "$user_root" "$family_root" "$local_root" "$sqlite_home" "$arg0_home"; do
      [ "$(stat -c %u -- "$target")" = "$uid" ] || exit 73
      chmod 0700 -- "$target"
    done
    arg0_link="$codex_home/tmp/arg0"
    arg0_local=1
    if [ -L "$arg0_link" ]; then
      [ "$(readlink -- "$arg0_link")" = "$arg0_home" ] || exit 73
    elif [ -e "$arg0_link" ]; then
      [ -d "$arg0_link" ] || exit 73
      if [ -z "$(find "$arg0_link" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        rmdir -- "$arg0_link"
      else
        active=0
        for candidate in $(ps -u "$uid" -o pid= 2>/dev/null); do
          [ -r "/proc/$candidate/environ" ] || continue
          if tr '\\0' '\\n' < "/proc/$candidate/environ" | grep -Fqx -- "CODEX_HOME=$codex_home"; then
            active=1
            break
          fi
        done
        if [ "$active" -eq 0 ]; then
          backup="$codex_home/tmp/arg0.pre-local-$(date +%s)-$$"
          mv -- "$arg0_link" "$backup"
        else
          arg0_local=0
        fi
      fi
      if [ "$arg0_local" -eq 1 ]; then
        ln -s -- "$arg0_home" "$arg0_link"
      fi
    else
      ln -s -- "$arg0_home" "$arg0_link"
    fi
    if [ "$arg0_local" -eq 1 ]; then
      mode=local
    else
      mode=local-sqlite
    fi
    printf '%s\\t%s\\t%s\\t%s\\n' '${CODEX_STORAGE_PROBE_MARKER}' "$mode" "$sqlite_home" "$fs_type"
    ;;
esac
`.trim();
    const result = await this.executor.exec(command, { maxOutputBytes: 16 * 1024 });
    invariant(result.code === 0, "AGENT_CODEX_LOCAL_RUNTIME_PREPARE_FAILED", "无法为 Codex 准备节点本地运行存储", {
      status: 502,
      retryable: true,
      details: { exitCode: result.code },
    });
    const marker = `${CODEX_STORAGE_PROBE_MARKER}\t`;
    const line = String(result.stdout || "").split(/\r?\n/).find((entry) => entry.startsWith(marker));
    if (!line) return Object.freeze({ mode: "persistent", filesystemType: "unknown", sqliteHome: null });
    const [, mode, sqliteHome, filesystemType] = line.split("\t");
    invariant(["persistent", "local", "local-sqlite"].includes(mode), "AGENT_CODEX_LOCAL_RUNTIME_RESPONSE_INVALID", "Codex 节点本地运行存储响应无效", {
      status: 502,
      retryable: true,
    });
    if (mode === "persistent") {
      return Object.freeze({ mode, filesystemType: String(filesystemType || "unknown"), sqliteHome: null });
    }
    const normalizedSqliteHome = path.posix.normalize(String(sqliteHome || ""));
    invariant(normalizedSqliteHome.startsWith("/tmp/easywork-") && normalizedSqliteHome.endsWith("/sqlite"), "AGENT_CODEX_LOCAL_RUNTIME_PATH_INVALID", "Codex 节点本地 SQLite 路径无效", {
      status: 502,
      retryable: true,
    });
    return Object.freeze({
      mode,
      filesystemType: String(filesystemType || "unknown"),
      sqliteHome: normalizedSqliteHome,
    });
  }

  async #prepareRuntime(paths, agentId, nativeStorePaths = paths) {
    const runtimeKey = `${String(paths.runtimeRoot)}\0${String(nativeStorePaths.runtimeRoot)}`;
    if (this.preparedRuntimeRoots.has(runtimeKey)) return;
    const runtimeSshDirectory = `${paths.runtimeHome}/.ssh`;
    const directories = [
      paths.agentCacheRoot,
      paths.runtimeRoot,
      paths.runtimeHome,
      runtimeSshDirectory,
      paths.runtimeConfig,
      paths.runtimeData,
      paths.runtimeCache,
      paths.runtimeState,
      paths.runtimeLogs,
      paths.skillsRoot,
      paths.filesRoot,
      paths.runtimeReleases,
      versionHookPaths(paths).root,
      versionHookPaths(paths).sessionTasks,
    ];
    const guarded = [...new Set([
      paths.easyworkRoot,
      `${paths.easyworkRoot}/runtime`,
      `${paths.easyworkRoot}/runtime/agents`,
      paths.agentRuntimeRoot,
      paths.skillsRoot,
      paths.filesRoot,
      ...directories,
    ])];
    const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
    const codexSkillView = `${paths.runtimeData}/codex/skills`;
    const qoderSkillView = `${paths.runtimeData}/qoder-cn/skills`;
    const skillViews = [
      `${paths.runtimeData}/claude/skills`,
      qoderSkillView,
      `${paths.runtimeConfig}/opencode/skills`,
    ];
    const claudeProjects = `${paths.runtimeData}/claude/projects`;
    const nativeClaudeProjects = `${nativeStorePaths.runtimeData}/claude/projects`;
    const qoderProjects = `${paths.runtimeData}/qoder-cn/projects`;
    const nativeQoderProjects = `${nativeStorePaths.runtimeData}/qoder-cn/projects`;
    const qoderAuth = `${paths.runtimeData}/qoder-cn/.auth`;
    if (agentId === "claude-code") directories.push(nativeClaudeProjects);
    if (agentId === "qoder-cn") {
      directories.push(paths.accountsRoot, paths.accountRoot, paths.accountAuthRoot, nativeQoderProjects);
      guarded.push(paths.accountsRoot, paths.accountRoot, paths.accountAuthRoot, nativeQoderProjects);
    }
    const parents = [codexSkillView, ...skillViews].map((entry) => entry.slice(0, entry.lastIndexOf("/")));
    const interactiveMarker = agentId === "codex"
      ? `CODEX_HOME=${nativeStorePaths.runtimeData}/codex`
      : agentId === "claude-code"
        ? `CLAUDE_CONFIG_DIR=${paths.runtimeData}/claude`
        : agentId === "qoder-cn"
          ? `QODERCN_CONFIG_DIR=${paths.runtimeData}/qoder-cn`
        : null;
    // Codex and Claude Code run on the SSH exec channel and cannot be
    // reattached by a new Gateway process.  If the host process was killed
    // without running close(), that channel's child can survive as an orphan
    // and keep an old environment/configuration alive.  Retire only the PID
    // recorded by this exact runtime root and only when /proc proves that the
    // process still owns this binding. OpenCode is deliberately excluded: its
    // loopback service is detached and is reattached through its current
    // servicePort contract.
    const retireOrphan = interactiveMarker ? [
      `active_file=${quote(`${paths.runtimeState}/active.json`)}`,
      `stale_pid="$(sed -n 's/.*\"processId\"[[:space:]]*:[[:space:]]*\"remote-\\([0-9][0-9]*\\)\".*/\\1/p' "$active_file" 2>/dev/null | head -n 1)"`,
      `if [ -n "$stale_pid" ] && [ -r "/proc/$stale_pid/environ" ] && tr '\\0' '\\n' < "/proc/$stale_pid/environ" | grep -Fqx -- ${quote(interactiveMarker)}; then kill -TERM "$stale_pid" 2>/dev/null || true; for wait_index in 1 2 3 4 5; do kill -0 "$stale_pid" 2>/dev/null || break; sleep 0.1; done; kill -0 "$stale_pid" 2>/dev/null && kill -KILL "$stale_pid" 2>/dev/null || true; fi`,
    ] : [];
    const command = [
      `for target in ${guarded.map(quote).join(" ")}; do [ ! -L "$target" ] || exit 73; done`,
      `mkdir -p ${[...directories, ...parents].map(quote).join(" ")}`,
      `chmod 0700 ${quote(paths.easyworkRoot)} ${quote(paths.runtimeRoot)} ${quote(runtimeSshDirectory)}`,
      ...retireOrphan,
      // Codex's native store can be shared by several logical Web branches.
      // Its global discovery directory must therefore stay empty: selected
      // Skills are supplied as exact turn input items from each logical
      // binding's own immutable Skill view.
      `[ ! -L ${quote(codexSkillView)} ] || rm -- ${quote(codexSkillView)}`,
      `[ ! -e ${quote(codexSkillView)} ] || [ -d ${quote(codexSkillView)} ] || exit 73`,
      `mkdir -p -- ${quote(codexSkillView)}`,
      ...skillViews.map((entry) => `ln -sfn -- ${quote(paths.skillsRoot)} ${quote(entry)}`),
      ...(agentId === "claude-code" && claudeProjects !== nativeClaudeProjects ? [
        `if [ -e ${quote(claudeProjects)} ] && [ ! -L ${quote(claudeProjects)} ]; then [ -d ${quote(claudeProjects)} ] && [ -z "$(ls -A -- ${quote(claudeProjects)})" ] || exit 73; rmdir -- ${quote(claudeProjects)}; fi`,
        `ln -sfn -- ${quote(nativeClaudeProjects)} ${quote(claudeProjects)}`,
      ] : agentId === "claude-code" ? [`mkdir -p -- ${quote(claudeProjects)}`] : []),
      ...(agentId === "qoder-cn" ? [
        `if [ -e ${quote(qoderAuth)} ] && [ ! -L ${quote(qoderAuth)} ]; then [ -d ${quote(qoderAuth)} ] && [ -z "$(ls -A -- ${quote(qoderAuth)})" ] || exit 73; rmdir -- ${quote(qoderAuth)}; fi`,
        `ln -sfn -- ${quote(paths.accountAuthRoot)} ${quote(qoderAuth)}`,
        ...(qoderProjects !== nativeQoderProjects ? [
          `if [ -e ${quote(qoderProjects)} ] && [ ! -L ${quote(qoderProjects)} ]; then [ -d ${quote(qoderProjects)} ] && [ -z "$(ls -A -- ${quote(qoderProjects)})" ] || exit 73; rmdir -- ${quote(qoderProjects)}; fi`,
          `ln -sfn -- ${quote(nativeQoderProjects)} ${quote(qoderProjects)}`,
        ] : [`mkdir -p -- ${quote(qoderProjects)}`]),
      ] : []),
    ].join(" && ");
    const result = await this.executor.exec(command);
    invariant(result.code === 0, "AGENT_RUNTIME_PREPARE_FAILED", "无法创建远端 Agent runtime 或 Skill 视图", { status: 502 });
    this.preparedRuntimeRoots.add(runtimeKey);
  }

  async #runtimeEnvironment(request, paths, installation, configuration = {}, route = null, nativeStorePaths = paths) {
    const extra = {};
    const agentId = String(request.adapterId || request.task?.route?.agentId || "");
    if (agentId === "opencode") {
      extra.XDG_CACHE_HOME = `${paths.agentCacheRoot}/${agentCacheVersionKey(installation.version)}`;
      extra.XDG_DATA_HOME = nativeStorePaths.runtimeData;
    }
    if (route) {
      const agentRoute = ["opencode", "codex"].includes(String(request.adapterId || request.task?.route?.agentId || ""))
        ? { ...route, baseUrl: openAiCompatibleBaseUrl(route.baseUrl) }
        : route;
      // A successful TCP probe is only a point-in-time observation. Keeping a
      // native Agent process on that direct route can strand an entire turn if
      // the remote network changes later, and it unnecessarily places the real
      // Provider credential in the remote environment. Default to the
      // host-owned SSH loopback relay; direct routing is reserved for callers
      // that explicitly declare the route stable and remotely reachable.
      const remoteReachable = agentRoute.remoteReachable === true;
      let endpoint = agentRoute.baseUrl;
      let runtimeKey = agentRoute.apiKey;
      if (!remoteReachable) {
        let proxy;
        try {
          proxy = await this.#proxyFor(request.binding.agentBindingId, agentRoute);
        } catch (error) {
          if (error?.code === "AGENT_API_UPSTREAM_UNREACHABLE") throw error;
          throw new ApiError("AGENT_API_PROXY_UNAVAILABLE", "远端无法访问模型 API，SSH loopback proxy 建立失败", {
            status: statusCode(error) || 502,
            details: { reason: String(error?.code || "proxy_failed") },
            cause: error,
          });
        }
        endpoint = `${proxy.protocol}://${proxy.host}:${proxy.port}${proxy.endpointPath}`;
        runtimeKey = "easywork-proxy";
        request.__runtimeProxy = { mode: "ssh-reverse", protocol: proxy.protocol };
      } else {
        await this.#releaseProxy(request.binding.agentBindingId);
        request.__runtimeProxy = { mode: "direct", protocol: new URL(agentRoute.baseUrl).protocol.replace(":", "") };
      }
      const providerEnvironment = apiEnvironment(endpoint, runtimeKey);
      const providerConfiguration = {
        schemaVersion: 1,
        agentId: String(request.adapterId || request.task?.route?.agentId || ""),
        providerId: String(agentRoute.providerId || ""),
        modelId: String(agentRoute.model || ""),
        endpoint,
        protocol: String(agentRoute.protocol || "auto"),
        route: request.__runtimeProxy ? structuredClone(request.__runtimeProxy) : { mode: "direct", protocol: new URL(endpoint).protocol.replace(":", "") },
        credentialDigest: crypto.createHash("sha256").update(runtimeKey).digest("hex"),
      };
      await Promise.all([
        this.#writeConfigurationIfChanged(paths.providerEnvironment, providerEnvironmentFile(providerEnvironment), { mode: 0o600 }),
        this.#writeConfigurationIfChanged(paths.providerConfiguration, `${JSON.stringify(providerConfiguration, null, 2)}\n`, { mode: 0o600 }),
      ]);
      Object.assign(extra, providerEnvironment, { EASYWORK_PROVIDER_ENV_FILE: paths.providerEnvironment });
    }
    if (configuration.effortLevel) extra.CLAUDE_CODE_EFFORT_LEVEL = configuration.effortLevel;
    if (agentId === "claude-code") {
      extra.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
      // EasyWork owns both provider routing and verified binary updates. Tell
      // Claude about that host boundary explicitly, and keep claude.ai account,
      // connector, telemetry and updater traffic from delaying the first
      // stream-json frame on restricted HPC login nodes.
      extra.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
      extra.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      extra.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
      extra.DISABLE_TELEMETRY = "1";
      extra.DISABLE_AUTOUPDATER = "1";
      extra.DISABLE_UPDATES = "1";
    }
    if (agentId === "qoder-cn") {
      extra.QODERCN_CONFIG_DIR = `${paths.runtimeData}/qoder-cn`;
      extra.DISABLE_TELEMETRY = "1";
      extra.DISABLE_AUTOUPDATER = "1";
      extra.DISABLE_UPDATES = "1";
    }
    if (Number.isSafeInteger(Number(configuration.contextLimit))) {
      extra.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Number(configuration.contextLimit));
    }
    if (agentId === "codex") extra.CODEX_HOME = `${nativeStorePaths.runtimeData}/codex`;
    return runtimeEnvironment(paths, extra);
  }

  async #proxyFor(bindingId, route) {
    const key = String(bindingId);
    const fingerprint = crypto.createHash("sha256").update(route.baseUrl).update("\0").update(route.apiKey).digest("hex");
    const existing = this.proxies.get(key);
    if (existing?.fingerprint === fingerprint && existing.handle?.isClosed?.() !== true) return existing.handle;
    if (existing) await this.#releaseProxy(key);
    const handle = await this.executor.openLoopbackProxy({ bindingId: key, baseUrl: route.baseUrl, apiKey: route.apiKey });
    this.proxies.set(key, { fingerprint, handle });
    return handle;
  }

  #bindEffortAdaptationHandler(context) {
    if (!["start", "resume"].includes(context.request.operation)
      && !(context.agentId === "opencode" && context.request.operation === "append")) return;
    if (context.request.__runtimeProxy?.mode !== "ssh-reverse") return;
    const handle = this.proxies.get(context.bindingId)?.handle;
    if (typeof handle?.setEffortAdaptationHandler !== "function") return;
    context.releaseEffortAdaptationHandler = handle.setEffortAdaptationHandler((detail) => {
      this.#queueEffortAdjustment(context, detail);
    });
  }

  #queueEffortAdjustment(context, detail) {
    const pending = this.#persistEffortAdjustment(context, detail).catch(() => null);
    context.effortAdjustments.push(pending);
  }

  async #persistEffortAdjustment(context, detail = {}) {
    const requestedEffort = String(detail.requestedEffort || "").trim().toLowerCase();
    const appliedEffort = String(detail.appliedEffort || "").trim().toLowerCase();
    if (!requestedEffort || !appliedEffort || requestedEffort === appliedEffort) return null;
    const field = context.agentId === "claude-code" ? "effortLevel" : "reasoningEffort";
    const configuredValue = String(context.configuration[field] || "").trim();
    if (!configuredValue || typeof this.configurationService?.adaptEffort !== "function") return null;
    const adapted = await this.configurationService.adaptEffort(context.agentId, {
      source: context.installation.source,
      configScope: context.configScope,
      configuredValue,
      requestedEffort,
      appliedEffort,
    });
    if (!adapted?.changed) return null;
    try {
      await this.refreshManagedConfiguration(context.agentId, { configScope: context.configScope });
    } catch {
      for (const entry of this.active.values()) {
        if (entry?.agentId === context.agentId && entry?.configScope === context.configScope) entry.preparedRuntime = null;
      }
    }
    const model = String(detail.model || context.apiRoute?.model || context.configuration.model || "当前模型").trim().slice(0, 512) || "当前模型";
    return {
      operation: "agent_effort_adjusted",
      message: `由于 ${model} 不接受 ${requestedEffort} 思考档位，已自动为您切换至 ${appliedEffort} 档位。`,
      agentId: context.agentId,
      model,
      field: adapted.field,
      requestedEffort,
      appliedEffort,
      supportedEfforts: Array.isArray(detail.supportedEfforts) ? detail.supportedEfforts.map(String) : [],
      configuration: adapted.configuration,
    };
  }

  async #releaseProxy(bindingId) {
    const key = String(bindingId);
    const entry = this.proxies.get(key);
    if (!entry) return;
    this.proxies.delete(key);
    await entry.handle?.close?.();
  }

  async #writeConfigurationIfChanged(path, content, { mode = 0o600 } = {}) {
    const key = String(path);
    const text = String(content);
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (this.configurationHashes.get(key) === hash) return false;
    await this.executor.writeAtomic(key, text, { mode, parentPrepared: true });
    this.configurationHashes.set(key, hash);
    return true;
  }

  async #detachOpenCodeNativeStore(paths, nativeStorePaths, { nativeStoreBindingId, installation }) {
    if (String(paths.runtimeRoot) === String(nativeStorePaths.runtimeRoot)) return;
    invariant(
      String(paths.agentRuntimeRoot) === String(nativeStorePaths.agentRuntimeRoot),
      "AGENT_OPENCODE_NATIVE_STORE_SCOPE_INVALID",
      "OpenCode 原生会话库不属于当前 Agent runtime",
      { status: 409 },
    );
    await this.#stopOpenCodeServiceForBinding({
      bindingId: nativeStoreBindingId,
      installation,
    });
    const scriptPath = `${paths.runtimeState}/opencode-native-store-clone-v${OPENCODE_NATIVE_STORE_CLONE_REVISION}.sh`;
    await this.#writeConfigurationIfChanged(scriptPath, OPENCODE_NATIVE_STORE_CLONE_SHELL, { mode: 0o700 });
    const result = await this.executor.exec([
      "sh",
      shellQuote(scriptPath),
      shellQuote(nativeStorePaths.runtimeData),
      shellQuote(paths.runtimeData),
      shellQuote(paths.agentRuntimeRoot),
    ].join(" "), { maxOutputBytes: 16 * 1024 });
    invariant(result.code === 0, "AGENT_OPENCODE_NATIVE_STORE_CLONE_FAILED", "无法为 OpenCode 网页分支建立独立原生会话库", {
      status: 502,
      retryable: true,
      details: { exitCode: Number(result.code) },
    });
  }

  async #openCodeCliProfile(installation, binding = null) {
    invariant(installation?.binaryPath, "AGENT_OPENCODE_INSTALLATION_INVALID", "OpenCode 安装信息不完整", {
      status: 500,
      expose: false,
    });
    const key = `opencode-capability\0${installation.binaryPath}\0${installation.version}`;
    let capability = this.cliCapabilityProfiles.get(key);
    if (!capability) {
      const pending = (async () => {
        const result = await this.executor.exec(`${shellQuote(installation.binaryPath)} debug v2 --help`, {
          maxOutputBytes: 128 * 1024,
        });
        return Object.freeze({ supportsV2: result.code === 0 });
      })();
      this.cliCapabilityProfiles.set(key, pending);
      try {
        capability = await pending;
        this.cliCapabilityProfiles.set(key, capability);
      } catch (error) {
        if (this.cliCapabilityProfiles.get(key) === pending) this.cliCapabilityProfiles.delete(key);
        throw error;
      }
    } else {
      capability = await capability;
    }
    const sessionId = String(binding?.native?.sessionId || binding?.state?.sessionId || "").trim();
    const nativeProtocol = sessionId && ["v1", "v2"].includes(binding?.native?.protocol)
      ? binding.native.protocol
      : null;
    const actualVersion = String(installation.version || "unknown");
    if (nativeProtocol === "v2" && !capability.supportsV2) {
      throw new ApiError("AGENT_OPENCODE_V2_UNAVAILABLE", `OpenCode ${actualVersion} 无法恢复该会话所需的 V2 协议`, {
        status: 409,
        expose: true,
        details: { actualVersion, requiredProtocol: "v2", capability: "debug v2" },
      });
    }
    // OpenCode 1.18.x exposes native fork only on its official /session API.
    // EasyWork therefore starts new Work bindings on V1 when requested by the
    // composition root, while an already persisted V2 session must keep V2.
    const configProtocol = nativeProtocol
      || (this.openCodeDefaultProtocol === "v1" ? "v1" : capability.supportsV2 ? "v2" : "v1");
    return Object.freeze({
      configProtocol,
      supportsV2: capability.supportsV2,
      issues: capability.supportsV2 ? [] : [{
        feature: "opencode_v2_protocol",
        agentVersion: actualVersion,
        blocking: false,
        eventType: "debug v2",
        message: `OpenCode ${actualVersion} 未提供 V2 目录协议；EasyWork 已使用该版本的 V1 原生接口。`,
      }],
    });
  }

  async #codexCliProfile(installation) {
    invariant(installation?.binaryPath, "AGENT_CODEX_INSTALLATION_INVALID", "Codex 安装信息不完整", {
      status: 500,
      expose: false,
    });
    const key = `codex-sandbox\0${installation.binaryPath}\0${installation.version}`;
    let capability = this.cliCapabilityProfiles.get(key);
    if (!capability) {
      const pending = (async () => {
        // Merely finding bwrap is insufficient on HPC/login nodes where user
        // namespaces are disabled. Execute a tiny isolated process so the
        // automatic mode reflects what Codex can actually use on this host.
        const result = await this.executor.exec("if command -v bwrap >/dev/null 2>&1; then bwrap --die-with-parent --unshare-all --share-net --ro-bind / / --dev /dev --proc /proc /bin/true >/dev/null 2>&1; else exit 127; fi", {
          maxOutputBytes: 16 * 1024,
        });
        return Object.freeze({
          sandboxStrategy: result.code === 0 ? "workspace-write" : "danger-full-access",
          sandboxAvailable: result.code === 0,
          issues: [],
        });
      })();
      this.cliCapabilityProfiles.set(key, pending);
      try {
        capability = await pending;
        this.cliCapabilityProfiles.set(key, capability);
      } catch (error) {
        if (this.cliCapabilityProfiles.get(key) === pending) this.cliCapabilityProfiles.delete(key);
        throw error;
      }
    } else {
      capability = await capability;
    }
    return capability;
  }

  async #applyIsolatedConfiguration(agentId, paths, configuration, apiRoute = null, installation = null, agentProfile = null) {
    const hookPaths = versionHookPaths(paths);
    const hookWrite = Promise.all([
      this.#writeConfigurationIfChanged(hookPaths.launcher, VERSION_PRETOOL_LAUNCHER, { mode: 0o700 }),
      this.#writeConfigurationIfChanged(hookPaths.script, VERSION_PRETOOL_PYTHON, { mode: 0o600 }),
    ]).then(async () => {
      const result = await this.executor.exec(versionHookCheckCommand(paths), { maxOutputBytes: 16 * 1024 });
      invariant(result.code === 0, "AGENT_VERSION_HOOK_RUNTIME_UNAVAILABLE", "远端环境缺少可用的 Python 3，无法启用文件回溯", {
        status: 502,
        details: { exitCode: result.code },
      });
    });
    if (agentId === "opencode") {
      const profile = agentProfile || await this.#openCodeCliProfile(installation);
      // OpenCode's OpenAI-compatible provider expects the API root that owns
      // /chat/completions. Normalize again at the configuration boundary so a
      // cached or independently refreshed route cannot regress to the service
      // root and make the AI SDK call a non-existent endpoint.
      const openCodeApiRoute = apiRoute
        ? { ...apiRoute, baseUrl: openAiCompatibleBaseUrl(apiRoute.baseUrl) }
        : null;
      const model = String(openCodeApiRoute?.model || configuration.model || "").trim();
      const compactionWindow = Number(configuration.contextLimit);
      const outputLimit = Number.isSafeInteger(compactionWindow) && compactionWindow > 0
        ? Math.max(1, Math.min(DEFAULT_OPENCODE_OUTPUT_LIMIT, Math.floor(compactionWindow / 4)))
        : null;
      const permissionEffect = ["allow", "deny", "ask"].includes(configuration.permissionMode)
        ? configuration.permissionMode
        : "ask";
      const content = profile.configProtocol === "v2"
        ? {
            "$schema": "https://opencode.ai/config.json",
            ...(model && openCodeApiRoute ? {
              model: `easywork/${model}`,
              providers: {
                easywork: {
                  name: "EasyWork",
                  env: ["OPENAI_API_KEY"],
                  api: {
                    type: "aisdk",
                    package: "@ai-sdk/openai-compatible",
                    url: openCodeApiRoute.baseUrl,
                    settings: {},
                  },
                  models: {
                    [model]: {
                      name: model,
                      api: {
                        id: model,
                        type: "aisdk",
                        package: "@ai-sdk/openai-compatible",
                        url: openCodeApiRoute.baseUrl,
                        settings: {},
                      },
                      capabilities: { tools: true, input: ["text"], output: ["text"] },
                      ...(Number.isSafeInteger(compactionWindow) && outputLimit ? {
                        limit: { context: compactionWindow, output: outputLimit },
                      } : {}),
                    },
                  },
                },
              },
            } : model ? { model } : {}),
            permissions: [
              { action: "*", resource: "*", effect: permissionEffect },
              ...(permissionEffect === "allow" ? [
                // These two permission events are EasyWork's pre-mutation
                // capture boundary and are answered internally after capture.
                { action: "edit", resource: "*", effect: "ask" },
                { action: "bash", resource: "*", effect: "ask" },
              ] : []),
              { action: "external_directory", resource: `${paths.skillsRoot}/**`, effect: "allow" },
            ],
            snapshots: true,
            compaction: { auto: true },
          }
        : {
            "$schema": "https://opencode.ai/config.json",
            ...(model && openCodeApiRoute ? {
              model: `easywork/${model}`,
              provider: {
                easywork: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "EasyWork",
                  options: {
                    baseURL: "{env:OPENAI_BASE_URL}",
                    apiKey: "{env:OPENAI_API_KEY}",
                  },
                  models: {
                    [model]: {
                      name: model,
                      ...(Number.isSafeInteger(compactionWindow) && outputLimit ? {
                        limit: { context: compactionWindow, output: outputLimit },
                      } : {}),
                    },
                  },
                },
              },
            } : model ? { model } : {}),
            permission: {
              "*": permissionEffect,
              ...(permissionEffect === "allow" ? { edit: "ask", bash: "ask" } : {}),
              external_directory: { [`${paths.skillsRoot}/**`]: "allow" },
            },
            snapshot: true,
            compaction: { auto: true },
          };
      await Promise.all([
        hookWrite,
        this.#writeConfigurationIfChanged(`${paths.runtimeConfig}/opencode/opencode.json`, `${JSON.stringify(content, null, 2)}\n`),
      ]);
      return profile;
    }
    if (agentId === "codex") {
      const hookCommand = versionHookCommand(paths);
      const hooks = [
        "",
        "[features]",
        "hooks = true",
        "",
        "[hooks]",
        "[[hooks.PreToolUse]]",
        "matcher = \".*\"",
        "",
        "[[hooks.PreToolUse.hooks]]",
        "type = \"command\"",
        `command = ${JSON.stringify(hookCommand)}`,
        "timeout = 120",
        `statusMessage = ${JSON.stringify(INTERNAL_VERSION_HOOK_STATUS)}`,
      ];
      await Promise.all([hookWrite, this.#writeConfigurationIfChanged(`${paths.runtimeData}/codex/config.toml`, `${[
        ...hooks,
      ].join("\n")}\n`)]);
      return agentProfile;
    }
    if (agentId === "claude-code") {
      const settings = {
        autoMemoryEnabled: false,
        ...(configuration.model ? { model: configuration.model } : {}),
        ...(configuration.effortLevel && configuration.effortLevel !== "auto" ? { effortLevel: configuration.effortLevel } : {}),
        ...(configuration.permissionMode ? { permissions: { defaultMode: configuration.permissionMode } } : {}),
        hooks: {
          PreToolUse: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: versionHookCommand(paths),
              timeout: 120,
              statusMessage: INTERNAL_VERSION_HOOK_STATUS,
            }],
          }],
        },
      };
      await Promise.all([hookWrite, this.#writeConfigurationIfChanged(`${paths.runtimeData}/claude/settings.json`, `${JSON.stringify(settings, null, 2)}\n`)]);
      return agentProfile;
    }
    if (agentId === "qoder-cn") {
      const contextWindow = Number(configuration.contextLimit);
      const settings = {
        general: {
          ...(configuration.permissionMode ? { defaultPermissionMode: configuration.permissionMode } : {}),
          enableAutoUpdate: false,
          fileCheckpointing: { enabled: true },
        },
        model: {
          ...(configuration.model ? { name: configuration.model } : {}),
          ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        },
        skills: { loadFromAgentsDirectory: true },
        hooks: {
          PreToolUse: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: versionHookCommand(paths),
              timeout: 120,
              statusMessage: INTERNAL_VERSION_HOOK_STATUS,
            }],
          }],
        },
      };
      await Promise.all([hookWrite, this.#writeConfigurationIfChanged(`${paths.runtimeData}/qoder-cn/settings.json`, `${JSON.stringify(settings, null, 2)}\n`)]);
      return agentProfile;
    }
    await hookWrite;
    return agentProfile;
  }

  async #recordRuntime(context, details) {
    const state = {
      schemaVersion: 1,
      agentId: context.agentId,
      agentBindingId: context.bindingId,
      nativeRuntimeBindingId: context.nativeStoreBindingId,
      conversationId: String(context.request.task?.conversationId || context.configScope || "default"),
      source: context.installation.source,
      managed: context.installation.source === "managed",
      version: context.installation.version,
      binaryPath: context.installation.binaryPath,
      updatedAt: new Date(this.clock()).toISOString(),
      ...details,
    };
    await this.executor.writeAtomic(`${context.paths.runtimeState}/active.json`, `${JSON.stringify(state, null, 2)}\n`, { parentPrepared: true });
  }

  async #bindCodexVersionTask(context, sessionId) {
    const nativeSessionId = String(sessionId || "");
    const taskId = String(context.request.task?.id || "");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(nativeSessionId), "AGENT_CODEX_SESSION_ID_INVALID", "Codex 文件版本 Hook 缺少有效原生会话", {
      status: 500,
      expose: false,
    });
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(taskId), "AGENT_VERSION_TASK_ID_INVALID", "Agent 文件版本 Hook 缺少当前 Task", {
      status: 500,
      expose: false,
    });
    const shared = versionHookPaths(context.nativeStorePaths || context.paths);
    const logical = versionHookPaths(context.paths);
    const binding = {
      schemaVersion: 1,
      taskId,
      hookRoot: logical.root,
    };
    return this.#writeConfigurationIfChanged(
      `${shared.sessionTasks}/${nativeSessionId}.json`,
      `${JSON.stringify(binding, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async #assertOpenCodeHealth(port, actualVersion = "unknown", timeoutMs = null) {
    const timeout = timeoutMs ? { timeoutMs } : {};
    let currentError = null;
    try {
      const current = await this.executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/api/health", ...timeout });
      if (current?.healthy === true || current?.data?.healthy === true) return { commonHealth: true };
    } catch (error) {
      currentError = error;
    }
    try {
      const legacy = await this.executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/global/health", ...timeout });
      if (legacy?.healthy === true || legacy?.data?.healthy === true) return { commonHealth: false };
    } catch (error) {
      if (!currentError) currentError = error;
    }
    throw new ApiError("AGENT_OPENCODE_HEALTH_INVALID", `OpenCode ${actualVersion} 返回了无法识别的健康状态`, {
      status: 503,
      retryable: true,
      expose: true,
      details: { actualVersion, capability: "health", reason: String(currentError?.code || "unhealthy") },
      cause: currentError,
    });
  }

  async #assertOpenCodeReady(port, context, timeoutMs = null) {
    const timeout = timeoutMs ? { timeoutMs } : {};
    const selectedModel = String(context.runtimeApiRoute?.model || context.configuration.model || "").trim();
    const actualVersion = String(context.installation?.version || "unknown");
    const existingSessionId = String(context.request.binding?.native?.sessionId || context.request.binding?.state?.sessionId || "").trim();
    const preferredProtocol = existingSessionId && ["v1", "v2"].includes(context.request.binding?.native?.protocol)
      ? context.request.binding.native.protocol
      : null;
    const configuredProtocol = ["v1", "v2"].includes(context.agentProfile?.configProtocol)
      ? context.agentProfile.configProtocol
      : null;
    const targetProtocol = preferredProtocol || configuredProtocol;
    let v2CatalogSeen = false;
    let v2ModelCount = null;
    let v2Ready = false;
    const { commonHealth } = await this.#assertOpenCodeHealth(port, actualVersion, timeoutMs);
    if (commonHealth && targetProtocol !== "v1") {
      try {
        const catalog = await this.executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/api/model", ...timeout });
        if (catalog && typeof catalog === "object" && !Array.isArray(catalog) && Array.isArray(catalog.data)) {
          v2CatalogSeen = true;
          const models = catalog.data;
          v2ModelCount = models.length;
          if (!selectedModel || models.some((model) => String(model?.providerID || "") === "easywork" && String(model?.id || "") === selectedModel)) {
            v2Ready = true;
          }
        }
      } catch (error) {
        if (!missingHttpCapability(error)) throw error;
      }
    }
    // V1 and V2 intentionally share `{ healthy: true }`. Protocol selection
    // therefore follows the generated config profile and matching catalog.
    let v1CatalogSeen = false;
    let v1ProviderCount = null;
    let v1Ready = false;
    if (targetProtocol !== "v2") {
      try {
        const catalog = await this.executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/provider", ...timeout });
        const value = catalog?.data && typeof catalog.data === "object" ? catalog.data : catalog;
        const providers = Array.isArray(value?.all) ? value.all : Array.isArray(value?.providers) ? value.providers : null;
        if (providers) {
          v1CatalogSeen = true;
          v1ProviderCount = providers.length;
          const provider = providers.find((entry) => String(entry?.id || entry?.providerID || "") === "easywork");
          const models = provider?.models && typeof provider.models === "object" ? provider.models : {};
          if (!selectedModel || (Boolean(provider) && (Object.hasOwn(models, selectedModel) || Object.values(models).some((model) => String(model?.id || "") === selectedModel)))) {
            v1Ready = true;
          }
        }
      } catch (error) {
        if (!missingHttpCapability(error)) throw error;
      }
    }
    // A native session cannot be resumed through the other protocol family:
    // their message projections and request routes are not interchangeable.
    if (preferredProtocol === "v2" && v2Ready) return "v2";
    if (preferredProtocol === "v1" && v1Ready) return "v1";
    if (!preferredProtocol && configuredProtocol === "v2" && v2Ready) return "v2";
    if (!preferredProtocol && configuredProtocol === "v1" && v1Ready) return "v1";
    if (!preferredProtocol && v2CatalogSeen && v2Ready) return "v2";
    // A release that exposes the V2 catalog route owns the current session
    // protocol even while its catalog plug-ins are still loading. Falling back
    // merely because V1 happens to list a model can create a session that the
    // current V1 message projection cannot mutate safely.
    if (!preferredProtocol && !v2CatalogSeen && v1Ready) return "v1";
    throw new ApiError("AGENT_OPENCODE_MODEL_NOT_READY", `OpenCode ${actualVersion} 已启动，但所选模型 ${selectedModel || "尚未配置"} 尚未出现在可用目录中`, {
      status: 503,
      retryable: true,
      expose: true,
      details: {
        actualVersion,
        model: selectedModel || null,
        preferredProtocol,
        configuredProtocol,
        catalogs: {
          v2: v2CatalogSeen ? { modelCount: v2ModelCount } : null,
          v1: v1CatalogSeen ? { providerCount: v1ProviderCount } : null,
        },
      },
    });
  }

  async #waitForOpenCode(port, context) {
    let lastError = null;
    const selectedModel = String(context.runtimeApiRoute?.model || context.configuration.model || "").trim();
    const deadline = Date.now() + OPENCODE_READY_TIMEOUT_MS;
    for (let attempt = 0; attempt < this.httpReadyAttempts; attempt += 1) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        return await this.#assertOpenCodeReady(port, context, Math.max(250, Math.min(OPENCODE_READY_REQUEST_TIMEOUT_MS, remaining)));
      } catch (error) {
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(this.httpReadyDelayMs, remaining));
      }
    }
    const actualVersion = String(context.installation?.version || "unknown");
    if (lastError?.code === "AGENT_OPENCODE_MODEL_NOT_READY") {
      throw new ApiError(lastError.code, lastError.message, {
        status: 502,
        expose: true,
        retryable: true,
        details: { ...(lastError.details || {}), actualVersion, model: selectedModel || null },
        cause: lastError,
      });
    }
    throw new ApiError("AGENT_SERVICE_START_FAILED", `OpenCode ${actualVersion} 服务或模型目录未就绪`, {
      status: 502,
      expose: true,
      details: { reason: String(lastError?.code || "readiness_timeout"), model: selectedModel || null, actualVersion },
      cause: lastError,
    });
  }

  async #openCodeService(context) {
    const key = activeEntryKey(context.request.binding);
    const pendingKey = `opencode\0${key}`;
    const pending = this.pendingProcessStarts.get(pendingKey);
    if (pending) await pending.catch(() => undefined);
    const start = this.#openCodeServiceCurrent(context);
    this.pendingProcessStarts.set(pendingKey, start);
    try {
      return await start;
    } finally {
      if (this.pendingProcessStarts.get(pendingKey) === start) this.pendingProcessStarts.delete(pendingKey);
    }
  }

  async #openCodeServiceCurrent(context) {
    const key = activeEntryKey(context.request.binding);
    let entry = this.active.get(key);
    const rememberedPort = Number(context.request.binding.native?.servicePort);
    const rememberedFingerprint = String(context.request.binding.native?.runtimeFingerprint || "");
    const refreshConfiguration = ["start", "resume", "prepare"].includes(context.request.operation)
      && context.runtimeFingerprint
      && context.runtimeFingerprint !== String(entry?.runtimeFingerprint || rememberedFingerprint);
    if (refreshConfiguration && Number.isSafeInteger(entry?.servicePort || rememberedPort)) {
      await this.#stopOpenCodeService(context, entry?.servicePort || rememberedPort, entry);
      entry = null;
    }
    if (entry?.agentId === "opencode") {
      entry.compatibilityIssues = [...(context.agentProfile?.issues || [])];
      if (Number(this.clock()) - Number(entry.lastHealthAt || 0) <= SERVICE_HEALTH_TTL_MS) {
        return entry;
      }
      try {
        // This in-memory service already passed the model-catalog gate before
        // accepting its first prompt. A later catalog refresh can be briefly
        // empty while the live session remains healthy; rechecking the model
        // here would kill a valid native conversation between two turns.
        await this.#assertOpenCodeHealth(entry.servicePort, context.installation?.version);
        entry.lastHealthAt = Number(this.clock());
        return entry;
      } catch {
        // A detached SSH handle only proves that a PID was allocated. If the
        // child exited during startup, keeping this entry makes every retry
        // open a forward to a dead port and surface "Connection refused".
        if (typeof entry.process.signal === "function") await entry.process.signal("SIGTERM").catch(() => undefined);
        if (this.active.get(key) === entry) this.active.delete(key);
        entry = null;
      }
    }
    if (!entry && Number.isSafeInteger(rememberedPort)) {
      try {
        const rememberedProtocol = ["v1", "v2"].includes(context.request.binding.native?.protocol)
          ? context.request.binding.native.protocol
          : null;
        const exactRuntime = rememberedProtocol
          && rememberedFingerprint
          && rememberedFingerprint === context.runtimeFingerprint;
        const protocol = exactRuntime
          ? (await this.#assertOpenCodeHealth(rememberedPort, context.installation?.version), rememberedProtocol)
          : await this.#assertOpenCodeReady(rememberedPort, context);
        entry = { agentId: "opencode", protocol, configScope: context.configScope, installation: context.installation, agentProfile: context.agentProfile, compatibilityIssues: [...(context.agentProfile?.issues || [])], process: null, servicePort: rememberedPort, paths: context.paths, runtimeApiRoute: context.runtimeApiRoute, runtimeFingerprint: rememberedFingerprint || null, lastHealthAt: Number(this.clock()) };
        this.active.set(key, entry);
        return entry;
      } catch {
        // The remembered process is gone; create a new isolated service.
      }
    }
    const port = servicePort(context.bindingId);
    try {
      const protocol = await this.#assertOpenCodeReady(port, context);
      entry = { agentId: "opencode", protocol, configScope: context.configScope, installation: context.installation, agentProfile: context.agentProfile, compatibilityIssues: [...(context.agentProfile?.issues || [])], process: null, servicePort: port, paths: context.paths, runtimeApiRoute: context.runtimeApiRoute, runtimeFingerprint: context.runtimeFingerprint, lastHealthAt: Number(this.clock()) };
      this.active.set(key, entry);
      return entry;
    } catch {
      // No reusable deterministic service exists for this binding.
    }
    const specification = {
      executable: context.installation.binaryPath,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: context.request.workspace?.path || context.request.descriptor.cwd || context.paths.runtimeHome,
      env: processEnvironment(context.environment),
      envFile: context.runtimeApiRoute ? context.paths.providerEnvironment : null,
      logPath: `${context.paths.runtimeLogs}/opencode-serve.log`,
    };
    // OpenCode is controlled through its loopback HTTP/SSE service. Detaching
    // it frees the SSH exec channel before opening the forwarding channels;
    // some HPC/managed SSH servers allow only one concurrent channel per
    // connection, which otherwise deadlocks immediately after a successful
    // spawn.
    const process = typeof this.executor.spawnDetached === "function"
      ? await this.executor.spawnDetached(specification)
      : await this.executor.spawn(specification);
    entry = { agentId: "opencode", protocol: null, configScope: context.configScope, installation: context.installation, agentProfile: context.agentProfile, compatibilityIssues: [...(context.agentProfile?.issues || [])], process, servicePort: port, paths: context.paths, runtimeApiRoute: context.runtimeApiRoute, runtimeFingerprint: context.runtimeFingerprint, lastHealthAt: 0 };
    this.active.set(key, entry);
    if (!process.detached) process.wait?.().finally(() => {
      if (this.active.get(key)?.process === process) this.active.delete(key);
    }).catch(() => {});
    try {
      entry.protocol = await this.#waitForOpenCode(port, context);
      entry.lastHealthAt = Number(this.clock());
      return entry;
    } catch (error) {
      if (this.active.get(key)?.process === process) this.active.delete(key);
      if (typeof process.signal === "function") await process.signal("SIGTERM").catch(() => undefined);
      await this.#releaseProxy(context.bindingId).catch(() => undefined);
      throw error;
    }
  }

  async #stopOpenCodeService(context, port, entry) {
    return this.#stopOpenCodeServiceForBinding({
      bindingId: context.request.binding.agentBindingId,
      installation: context.installation,
      port,
      entry,
    });
  }

  async #stopOpenCodeServiceForBinding({ bindingId, installation, port = null, entry = null }) {
    const key = assertRuntimeIdentifier(bindingId, "agentBindingId");
    const activeEntry = entry || this.active.get(key) || null;
    const resolvedPort = Number(activeEntry?.servicePort || port || servicePort(key));
    invariant(Number.isSafeInteger(resolvedPort), "AGENT_SERVICE_PORT_INVALID", "OpenCode 服务端口无效", { status: 500, expose: false });
    if (activeEntry?.process && !activeEntry.process.closed && typeof activeEntry.process.signal === "function") {
      await activeEntry.process.signal("SIGTERM").catch(() => undefined);
    }
    const command = `${installation.binaryPath} serve --hostname 127.0.0.1 --port ${resolvedPort}`;
    const stopped = await this.executor.exec(
      `pids="$(pgrep -f -x -- ${shellQuote(command)} || true)"; if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; sleep 0.25; for pid in $pids; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done; fi`,
    );
    invariant(stopped.code === 0, "AGENT_SERVICE_RESTART_FAILED", "无法重新载入 OpenCode 隔离配置", { status: 502 });
    this.active.delete(key);
  }

  async #stopOpenCodeNativeRun(entry, sessionId) {
    const statusPath = entry.protocol === "v1" ? "/session/status" : "/api/session/active";
    const interruptPath = entry.protocol === "v1"
      ? `/session/${encodeURIComponent(sessionId)}/abort`
      : `/api/session/${encodeURIComponent(sessionId)}/interrupt`;
    let wasBusy = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.executor.requestHttp({
        host: "127.0.0.1",
        port: entry.servicePort,
        method: "GET",
        path: statusPath,
      });
      if (!openCodeSessionIsBusy(before, sessionId, entry.protocol)) return { interrupted: wasBusy, idle: true };
      wasBusy = true;
      await this.executor.requestHttp({
        host: "127.0.0.1",
        port: entry.servicePort,
        method: "POST",
        path: interruptPath,
      });
      for (let poll = 0; poll < 20; poll += 1) {
        const snapshot = await this.executor.requestHttp({
          host: "127.0.0.1",
          port: entry.servicePort,
          method: "GET",
          path: statusPath,
        });
        if (!openCodeSessionIsBusy(snapshot, sessionId, entry.protocol)) return { interrupted: true, idle: true };
        await sleep(100);
      }
    }
    return { interrupted: wasBusy, idle: false };
  }

  async #openCodeRequest(context, entry, request, variables) {
    const resolved = deepSubstitute(request, variables);
    const configuredVariant = String(context.configuration.reasoningEffort || "").trim();
    const variant = configuredVariant && configuredVariant !== "default" ? configuredVariant : "";
    if (entry.protocol === "v1") {
      const directory = String(context.request.workspace?.path || "").trim();
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : "";
      const model = String(context.runtimeApiRoute?.model || context.configuration.model || "").trim();
      let legacy = resolved;
      if (resolved.method === "POST" && resolved.path === "/api/session") {
        legacy = { ...resolved, path: `/session${query}`, body: {} };
      } else {
        const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(resolved.path);
        const compact = /^\/api\/session\/([^/]+)\/compact$/.exec(resolved.path);
        const interrupt = /^\/api\/session\/([^/]+)\/interrupt$/.exec(resolved.path);
        const fork = /^\/api\/session\/([^/]+)\/fork$/.exec(resolved.path);
        const revert = /^\/api\/session\/([^/]+)\/revert$/.exec(resolved.path);
        const unrevert = /^\/api\/session\/([^/]+)\/unrevert$/.exec(resolved.path);
        const permission = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(resolved.path);
        const question = /^\/api\/session\/([^/]+)\/question\/([^/]+)\/reply$/.exec(resolved.path);
        if (prompt) {
          if (context.nativeSkillCommand) {
            const catalog = await this.executor.requestHttp({ host: "127.0.0.1", port: entry.servicePort, method: "GET", path: `/command${query}` });
            const commands = Array.isArray(catalog) ? catalog : catalog?.data || [];
            invariant(commands.some((item) => item.name === context.nativeSkillCommand.name), "AGENT_SKILL_NOT_DISCOVERED", "OpenCode 未发现本轮原生技能命令", { status: 409 });
            context.pendingSubmission = this.executor.requestHttp({ host: "127.0.0.1", port: entry.servicePort, method: "POST", path: `/session/${prompt[1]}/command${query}`, body: {
              command: context.nativeSkillCommand.name, arguments: String(resolved.body?.prompt?.text || ""),
              ...(model ? { model: `easywork/${model}` } : {}), ...(variant ? { variant } : {}),
            }, waitForTurn: true, timeoutMs: 12 * 60 * 60 * 1000 });
            context.pendingSubmission.catch(() => undefined);
            return null;
          }
          legacy = {
            ...resolved,
            path: `/session/${prompt[1]}/prompt_async${query}`,
            body: {
              parts: [{ type: "text", text: String(resolved.body?.prompt?.text || "") }],
              ...(model ? { model: { providerID: "easywork", modelID: model } } : {}),
              ...(variant ? { variant } : {}),
            },
          };
        } else if (compact) {
          legacy = {
            ...resolved,
            path: `/session/${compact[1]}/summarize${query}`,
            body: { providerID: "easywork", modelID: model },
          };
        } else if (interrupt) {
          legacy = { ...resolved, path: `/session/${interrupt[1]}/abort${query}` };
        } else if (fork) {
          legacy = { ...resolved, path: `/session/${fork[1]}/fork${query}` };
        } else if (revert) {
          legacy = { ...resolved, path: `/session/${revert[1]}/revert${query}` };
        } else if (unrevert) {
          legacy = { ...resolved, path: `/session/${unrevert[1]}/unrevert${query}` };
        } else if (permission) {
          legacy = {
            ...resolved,
            path: `/permission/${permission[2]}/reply${query}`,
            body: { reply: String(resolved.body?.reply || "once") },
          };
        } else if (question) {
          legacy = {
            ...resolved,
            path: `/question/${question[2]}/reply${query}`,
            body: { answers: Array.isArray(resolved.body?.answers) ? resolved.body.answers : [] },
          };
        }
      }
      return this.executor.requestHttp({
        host: "127.0.0.1",
        port: entry.servicePort,
        method: legacy.method,
        path: legacy.path,
        body: legacy.body,
      });
    }
    if (resolved.method === "POST" && resolved.path === "/api/session") {
      const model = String(context.runtimeApiRoute?.model || context.configuration.model || "").trim();
      resolved.body = {
        ...(resolved.body && typeof resolved.body === "object" ? resolved.body : {}),
        ...(model ? { model: { providerID: "easywork", id: model } } : {}),
        ...(context.request.workspace?.path ? { location: { directory: String(context.request.workspace.path) } } : {}),
      };
    }
    if (resolved.method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(resolved.path) && variant) {
      resolved.body = {
        ...(resolved.body && typeof resolved.body === "object" ? resolved.body : {}),
        variant,
      };
    }
    const result = await this.executor.requestHttp({
      host: "127.0.0.1",
      port: entry.servicePort,
      method: resolved.method,
      path: resolved.path,
      body: resolved.body,
    });
    return result;
  }

  async #selectOpenCodeModel(context, entry, sessionId) {
    if (entry.protocol === "v1") return;
    const model = String(context.runtimeApiRoute?.model || context.configuration.model || "").trim();
    if (!model) return;
    await this.executor.requestHttp({
      host: "127.0.0.1",
      port: entry.servicePort,
      method: "POST",
      path: `/api/session/${encodeURIComponent(sessionId)}/model`,
      body: { model: { providerID: "easywork", id: model } },
    });
  }

  async #moveOpenCodeSessionWorkspace(context, entry, sessionId) {
    // The Web route is updated as soon as the user confirms the workspace
    // switch, before this native request starts.  It therefore cannot tell us
    // where the persisted OpenCode session still lives.  Track the last
    // successfully used native location instead; legacy bindings without this
    // metadata deliberately probe move-session once so they cannot silently
    // keep running in their old directory.
    const sourceWorkspaceId = String(context.request.binding.native?.workspaceId || "");
    const sourceDirectory = String(context.request.binding.native?.workspacePath || "").trim();
    const targetWorkspaceId = String(context.request.task?.route?.workspaceId || "");
    const targetDirectory = String(context.request.workspace?.path || "").trim();
    if (!targetDirectory) return false;
    if ((sourceDirectory && sourceDirectory === targetDirectory)
      || (sourceWorkspaceId && targetWorkspaceId && sourceWorkspaceId === targetWorkspaceId)) return false;
    try {
      await this.executor.requestHttp({
        host: "127.0.0.1",
        port: entry.servicePort,
        method: "POST",
        path: "/experimental/control-plane/move-session",
        body: {
          sessionID: String(sessionId),
          destination: { directory: targetDirectory },
          moveChanges: false,
        },
      });
      return true;
    } catch (error) {
      throw new ApiError("AGENT_NATIVE_WORKSPACE_MOVE_UNAVAILABLE", `OpenCode ${String(context.installation.version || "unknown")} 无法把当前原生会话切换到所选工作区`, {
        status: statusCode(error) || 409,
        retryable: false,
        expose: true,
        details: {
          agentId: "opencode",
          sessionId: String(sessionId),
          sourceWorkspaceId,
          targetWorkspaceId,
          targetDirectory,
          reason: String(error?.code || error?.message || "move_session_failed"),
        },
        cause: error,
      });
    }
  }

  async #executeOpenCode(context) {
    invariant(["http"].includes(context.request.descriptor.transport), "AGENT_TRANSPORT_UNSUPPORTED", "OpenCode operation 需要 HTTP transport", {
      status: 409,
    });
    const entry = await this.#openCodeService(context);
    const operation = context.request.operation;
    let lines = null;
    let turnAfterSequence = null;
    let baselineMessageIds = new Set();
    let forkSourceMessages = [];
    let nativeBoundaryMap = null;
    const variables = {};
    let effectiveRequest = context.request.descriptor.request;
    const descriptorSessionId = openCodeRequestSessionId(context.request.descriptor.request);
    let sessionId = String(
      (["fork", "revert"].includes(operation) ? descriptorSessionId : null)
        || context.request.binding.native?.sessionId
        || context.request.binding.state?.sessionId
        || descriptorSessionId
        || "",
    );
    if (sessionId && ["start", "resume"].includes(operation)) {
      await this.#moveOpenCodeSessionWorkspace(context, entry, sessionId);
    }
    if (entry.protocol === "v1" && sessionId && ["start", "append", "resume"].includes(operation)) {
      baselineMessageIds = new Set((await openCodeV1Messages(this.executor, entry.servicePort, sessionId)).map(openCodeV1MessageId).filter(Boolean));
    }
    if (entry.protocol === "v1" && operation === "append" && sessionId) {
      // OpenCode V1 persists a prompt received during an active LLM step, but
      // Runner.ensureRunning only waits for that step; it does not steer it.
      // Stop the native step before submitting the new prompt so the user's
      // mid-run correction becomes the next model input immediately while the
      // same native session and EasyWork Task remain alive.
      const steered = await this.#stopOpenCodeNativeRun(entry, sessionId);
      invariant(steered.idle, "AGENT_OPENCODE_STEER_NOT_CONFIRMED", "OpenCode 未确认当前生成已为追加消息让出执行边界", {
        status: 502,
        retryable: true,
        details: { sessionId, protocol: entry.protocol },
      });
    }
    if (entry.protocol === "v1" && sessionId && ["fork", "revert"].includes(operation) && context.request.descriptor.boundary) {
      const messages = await openCodeV1Messages(this.executor, entry.servicePort, sessionId);
      const retainedMessageId = String(context.request.descriptor.boundary.messageId || "");
      const retainedIndex = retainedMessageId
        ? messages.findIndex((message) => openCodeV1MessageId(message) === retainedMessageId)
        : -1;
      invariant(!retainedMessageId || retainedIndex >= 0, "AGENT_OPENCODE_BOUNDARY_NOT_FOUND", "OpenCode 原生消息边界不存在", {
        status: 409,
        details: { sessionId, messageId: retainedMessageId },
      });
      const exclusive = messages[retainedMessageId ? retainedIndex + 1 : 0] || null;
      const exclusiveMessageId = openCodeV1MessageId(exclusive);
      if (operation === "fork") {
        forkSourceMessages = messages.slice(0, retainedMessageId ? retainedIndex + 1 : 0);
      }
      if (operation === "revert") {
        invariant(exclusiveMessageId, "AGENT_OPENCODE_REVERT_ALREADY_AT_BOUNDARY", "OpenCode 原生会话已经位于目标边界", { status: 409 });
      }
      effectiveRequest = {
        ...effectiveRequest,
        body: exclusiveMessageId ? { messageID: exclusiveMessageId } : {},
      };
    }
    if (entry.protocol !== "v1" && operation === "fork") {
      throw new ApiError("AGENT_OPENCODE_NATIVE_FORK_UNAVAILABLE", "当前 OpenCode V2 原生会话没有 fork 接口", {
        status: 409,
        expose: true,
        details: { sessionId, protocol: entry.protocol || "unknown" },
      });
    }
    if (entry.protocol === "v2" && operation === "revert") {
      if (context.request.descriptor.undo === true) {
        effectiveRequest = {
          method: "POST",
          path: `/api/session/${encodeURIComponent(sessionId)}/revert/clear`,
          body: {},
        };
      } else if (context.request.descriptor.phase === "commit") {
        effectiveRequest = {
          method: "POST",
          path: `/api/session/${encodeURIComponent(sessionId)}/revert/commit`,
          body: {},
        };
      } else {
        const retainedMessageId = String(context.request.descriptor.boundary?.messageId || "");
        invariant(retainedMessageId, "AGENT_OPENCODE_BOUNDARY_NOT_FOUND", "OpenCode V2 原生回溯缺少消息边界", { status: 409 });
        effectiveRequest = {
          method: "POST",
          path: `/api/session/${encodeURIComponent(sessionId)}/revert/stage`,
          body: { messageID: retainedMessageId, files: true },
        };
      }
    }
    if (Array.isArray(context.request.descriptor.transaction)) {
      for (const [index, request] of context.request.descriptor.transaction.entries()) {
        if (index === 1 && ["start", "resume"].includes(operation)) {
          invariant(sessionId, "AGENT_NATIVE_SESSION_MISSING", "OpenCode 未返回 session id", { status: 502 });
          lines = await openOpenCodeEventStream(this.executor, entry.servicePort, entry.protocol, context.request.workspace?.path || "");
        }
        const resolvedRequest = deepSubstitute(request, variables);
        const result = await this.#openCodeRequest(context, entry, request, variables);
        // Prompt/message responses also contain an `id` (normally `msg_*`).
        // Only the native create endpoint is allowed to establish
        // `$session.id`; otherwise a prompt's message id replaces the real
        // `ses_*` id and SSE scoping plus history recovery silently see no
        // events.
        const createsSession = resolvedRequest.method === "POST"
          && resolvedRequest.path === "/api/session";
        const createdSessionId = createsSession
          ? result?.data?.id || result?.id || result?.session?.id
          : null;
        if (createdSessionId) {
          variables["$session.id"] = String(createdSessionId);
          sessionId = String(createdSessionId);
        }
        if (entry.protocol !== "v1" && resolvedRequest.method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(resolvedRequest.path)) {
          const admittedSequence = Number(result?.data?.admittedSeq);
          invariant(Number.isSafeInteger(admittedSequence) && admittedSequence > 0,
            "AGENT_OPENCODE_PROMPT_NOT_ADMITTED", "OpenCode 未确认当前消息的原生事件边界", { status: 502 });
          turnAfterSequence = admittedSequence - 1;
        }
      }
      invariant(variables["$session.id"], "AGENT_NATIVE_SESSION_MISSING", "OpenCode 未返回 session id", { status: 502 });
    } else {
      if (["start", "append", "resume"].includes(operation)) {
        invariant(sessionId, "AGENT_NATIVE_SESSION_MISSING", "OpenCode operation 缺少 native session", { status: 409 });
        await this.#selectOpenCodeModel(context, entry, sessionId);
        lines = await openOpenCodeEventStream(this.executor, entry.servicePort, entry.protocol, context.request.workspace?.path || "");
      }
      const result = await this.#openCodeRequest(context, entry, effectiveRequest, variables);
      const resolvedRequest = deepSubstitute(effectiveRequest, variables);
      if (operation === "fork") {
        const forkedSessionId = result?.data?.id || result?.id || result?.session?.id;
        invariant(forkedSessionId, "AGENT_NATIVE_SESSION_MISSING", "OpenCode fork 未返回新的 session id", { status: 502 });
        sessionId = String(forkedSessionId);
      }
      if (["start", "append", "resume"].includes(operation)) {
        invariant(resolvedRequest.method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(resolvedRequest.path),
          "AGENT_OPENCODE_PROMPT_ROUTE_INVALID", "OpenCode 当前消息没有使用原生 prompt 路由", { status: 500, expose: false });
        if (entry.protocol !== "v1") {
          const admittedSequence = Number(result?.data?.admittedSeq);
          invariant(Number.isSafeInteger(admittedSequence) && admittedSequence > 0,
            "AGENT_OPENCODE_PROMPT_NOT_ADMITTED", "OpenCode 未确认当前消息的原生事件边界", { status: 502 });
          turnAfterSequence = admittedSequence - 1;
        }
      }
    }
    if (operation === "interrupt") {
      const sessionId = String(
        context.request.binding.native?.sessionId
          || context.request.binding.state?.sessionId
          || "",
      );
      invariant(sessionId, "AGENT_NATIVE_SESSION_MISSING", "OpenCode interrupt 缺少 native session", { status: 409 });
      const interrupted = await this.#stopOpenCodeNativeRun(entry, sessionId);
      invariant(interrupted.idle, "AGENT_INTERRUPT_NOT_CONFIRMED", "OpenCode 未确认任务已停止", {
        status: 502,
        retryable: true,
      });
    }
    let nativeTurnId = null;
    if (operation === "fork" && entry.protocol === "v1") {
      const childMessages = await openCodeV1Messages(this.executor, entry.servicePort, sessionId);
      invariant(childMessages.length === forkSourceMessages.length, "AGENT_OPENCODE_FORK_BOUNDARY_MISMATCH", "OpenCode fork 返回的消息边界与来源会话不一致", {
        status: 502,
        retryable: true,
        details: { sourceCount: forkSourceMessages.length, childCount: childMessages.length },
      });
      nativeBoundaryMap = {};
      for (let index = 0; index < forkSourceMessages.length; index += 1) {
        const sourceMessage = forkSourceMessages[index];
        const childMessage = childMessages[index];
        const sourceId = openCodeV1MessageId(sourceMessage);
        const childId = openCodeV1MessageId(childMessage);
        invariant(sourceId && childId && sourceMessage?.info?.role === childMessage?.info?.role,
          "AGENT_OPENCODE_FORK_BOUNDARY_MISMATCH", "OpenCode fork 返回的消息顺序与来源会话不一致", {
            status: 502,
            retryable: true,
            details: { index, sourceId: sourceId || null, childId: childId || null },
          });
        nativeBoundaryMap[sourceId] = childId;
      }
      nativeTurnId = [...childMessages].reverse().find((message) => message?.info?.role === "assistant")?.info?.id || null;
    } else if (operation === "revert" && context.request.descriptor.boundary) {
      nativeTurnId = String(context.request.descriptor.boundary.messageId || "") || null;
    } else if (operation === "revert") {
      nativeTurnId = context.request.binding.native?.turnId || context.request.binding.state?.turnId || null;
    }
    const runId = ["start", "resume", "append"].includes(operation)
      ? createRuntimeRunId(context.agentId, context.bindingId, this.clock)
      : nativeRunId(context.request.binding);
    const runtimePersistence = this.#recordRuntime(context, {
      runId,
      status: operation === "interrupt" ? "interrupted" : ["fork", "revert"].includes(operation) ? "idle" : "running",
      processId: entry.process?.processId || context.request.binding.native?.processId || null,
      servicePort: entry.servicePort,
      protocol: entry.protocol || "unknown",
    }).then(() => null, (error) => error);
    if (!lines) {
      const persistenceError = await runtimePersistence;
      if (persistenceError) throw persistenceError;
    }
    const compatibilityFrames = lines && !entry.compatibilityIssuesAnnounced
      ? (entry.compatibilityIssues || []).map((issue) => ({ type: "easywork.compatibility.issue", data: { issue } }))
      : [];
    if (compatibilityFrames.length) entry.compatibilityIssuesAnnounced = true;
    return {
      runId,
      ...(nativeBoundaryMap ? { nativeBoundaryMap } : {}),
      bindingPatch: {
        ...(["fork", "revert"].includes(operation) ? {
          state: { sessionId, turnId: nativeTurnId, status: "idle" },
        } : {}),
        native: {
          agentSource: context.installation.source,
          binaryPath: context.installation.binaryPath,
          processId: entry.process?.processId || context.request.binding.native?.processId || null,
          servicePort: entry.servicePort,
          protocol: entry.protocol || "unknown",
          runtimeRoot: context.paths.runtimeRoot,
          runtimeBindingId: context.nativeStoreBindingId,
          runtimeStoreRoot: context.nativeStorePaths.runtimeRoot,
          skillsRoot: context.paths.skillsRoot,
          ...(sessionId ? { sessionId } : {}),
          ...(context.request.task?.route?.workspaceId
            ? { workspaceId: String(context.request.task.route.workspaceId) }
            : {}),
          ...(context.request.workspace?.path
            ? { workspacePath: String(context.request.workspace.path) }
            : {}),
          ...(["fork", "revert"].includes(operation) ? { turnId: nativeTurnId } : {}),
          ...(context.runtimeFingerprint ? { runtimeFingerprint: context.runtimeFingerprint } : {}),
          ...(context.request.__runtimeProxy ? { apiProxy: context.request.__runtimeProxy } : {}),
        },
      },
      ...(lines ? {
        frames: withNativeSubmission(framesWithRequiredPersistence(coalescedAgentFrames(governedOpenCodeFrames({
          frames: prefixedFrames(
            entry.protocol === "v1"
              ? resilientOpenCodeV1Frames({
                  lines,
                  executor: this.executor,
                  port: entry.servicePort,
                  sessionId,
                  baselineMessageIds,
                  pollIntervalMs: this.openCodePollIntervalMs,
                  agentVersion: context.installation.version,
                  directory: context.request.workspace?.path || "",
                })
              : resilientOpenCodeFrames({
                  lines,
                  executor: this.executor,
                  port: entry.servicePort,
                  sessionId,
                  afterSequence: turnAfterSequence ?? Number(context.request.binding.state?.eventSequence || 0),
                  pollIntervalMs: this.openCodePollIntervalMs,
                }),
            compatibilityFrames,
          ),
          executor: this.executor,
          port: entry.servicePort,
          sessionId,
          protocol: entry.protocol,
          permissionMode: context.configuration.permissionMode,
          paths: context.paths,
          workspacePath: context.request.workspace?.path || context.paths.runtimeHome,
          taskId: context.request.task?.id,
        }), "opencode"), runtimePersistence, context.installation.version), context.pendingSubmission),
      } : {}),
    };
  }

  async #codexProcess(context) {
    const key = activeEntryKey(context.request.binding);
    const pendingKey = `codex\0${key}`;
    const pending = this.pendingProcessStarts.get(pendingKey);
    if (pending) await pending.catch(() => undefined);
    let entry = this.active.get(key);
    if (entry?.agentId === "codex" && entry.process && !entry.process.closed) {
      const requiresExactRuntime = ["prepare", "start", "resume"].includes(context.request.operation);
      const stalePreparation = requiresExactRuntime
        && entry.runtimeFingerprint !== context.runtimeFingerprint;
      // A logical Web branch can share a native Codex store with its source
      // branch.  Conversely, a verified native-session replacement can move
      // the same logical binding back to its own store.  CODEX_HOME is fixed
      // when app-server starts, so never reuse a process across that boundary.
      const staleNativeStore = requiresExactRuntime
        && String(entry.nativeStorePaths?.runtimeRoot || "") !== String(context.nativeStorePaths?.runtimeRoot || "");
      if (!stalePreparation && !staleNativeStore) {
        this.#touchNativeProcess(entry);
        return entry;
      }
      await entry.process.signal("SIGTERM").catch(() => undefined);
      if (this.active.get(key) === entry) this.active.delete(key);
      entry = null;
    }
    const start = (async () => {
      const process = await this.executor.spawn({
        executable: context.installation.binaryPath,
        // App-server supports repeated global -c/--config values. Keep
        // process-specific model, permission, sandbox and provider routing in
        // that highest-precedence layer so logical Web branches can share the
        // native Codex thread store without racing on config.toml.
        args: ["app-server", ...codexRuntimeConfigArguments(context.configuration, context.runtimeApiRoute, context.agentProfile)],
        cwd: context.request.workspace?.path || context.paths.runtimeHome,
        env: processEnvironment(context.environment),
        envFile: context.runtimeApiRoute ? context.paths.providerEnvironment : null,
      });
      try {
        await process.requestJsonRpc("initialize", {
          clientInfo: { name: "easywork", title: "EasyWork", version: "2" },
          capabilities: { experimentalApi: true },
        });
        invariant(typeof process.notifyJsonRpc === "function", "AGENT_CODEX_INITIALIZE_UNSUPPORTED", "Codex process 不支持 initialized notification", {
          status: 500,
          expose: false,
        });
        process.notifyJsonRpc("initialized");
        await process.requestJsonRpc("skills/extraRoots/set", { extraRoots: [context.paths.skillsRoot] });
      } catch (error) {
        if (typeof process.signal === "function") await process.signal("SIGTERM").catch(() => undefined);
        const agentVersion = String(context.installation.version || "unknown");
        throw new ApiError("AGENT_CODEX_PROTOCOL_UNAVAILABLE", `Codex ${agentVersion} 没有提供 EasyWork 所需的 app-server 初始化协议`, {
          status: 409,
          details: { actualVersion: agentVersion, protocol: "codex-app-server-jsonrpc", reason: String(error?.code || error?.message || "initialize_failed") },
          cause: error,
        });
      }
      let hookProfile;
      try {
        hookProfile = await this.#validateCodexVersionHook(context, process);
      } catch (error) {
        if (typeof process.signal === "function") await process.signal("SIGTERM").catch(() => undefined);
        throw error;
      }
      const started = {
        agentId: "codex",
        configScope: context.configScope,
        process,
        paths: context.paths,
        nativeStorePaths: context.nativeStorePaths,
        runtimeApiRoute: context.runtimeApiRoute,
        runtimeFingerprint: context.runtimeFingerprint,
        bypassHookTrust: hookProfile.bypassHookTrust,
        // Codex persists every thread in CODEX_HOME, but each app-server
        // process still has to load that thread before turn/start can use it.
        // This set is deliberately process-local and disappears with entry.
        loadedThreadIds: new Set(),
        compatibilityIssues: [
          ...(context.agentProfile?.issues || []),
          ...(hookProfile.compatibilityIssue ? [hookProfile.compatibilityIssue] : []),
        ],
      };
      this.active.set(key, started);
      process.wait?.().finally(() => {
        if (this.active.get(key)?.process === process) {
          this.active.delete(key);
        }
      }).catch(() => {});
      return started;
    })();
    this.pendingProcessStarts.set(pendingKey, start);
    try {
      const started = await start;
      this.#touchNativeProcess(started);
      return started;
    } finally {
      if (this.pendingProcessStarts.get(pendingKey) === start) this.pendingProcessStarts.delete(pendingKey);
    }
  }

  async #validateCodexVersionHook(context, process) {
    const cwd = String(context.request.workspace?.path || context.paths.runtimeHome);
    const nativeStorePaths = context.nativeStorePaths || context.paths;
    const sourcePath = `${nativeStorePaths.runtimeData}/codex/config.toml`;
    const command = versionHookCommand(nativeStorePaths);
    try {
      const list = async () => {
        const response = await process.requestJsonRpc("hooks/list", { cwds: [cwd] });
        invariant(response && typeof response === "object" && !Array.isArray(response) && Array.isArray(response.data),
          "AGENT_CODEX_HOOK_LIST_INVALID", "Codex 未返回当前版本的 Hook 清单", { status: 502 });
        const entry = response.data.find((candidate) => candidate?.cwd === cwd) || null;
        invariant(entry && Array.isArray(entry.hooks) && Array.isArray(entry.warnings) && Array.isArray(entry.errors),
          "AGENT_CODEX_HOOK_LIST_INVALID", "Codex 当前工作区 Hook 清单无效", { status: 502 });
        invariant(entry.errors.length === 0, "AGENT_CODEX_HOOK_DISCOVERY_FAILED", "Codex 无法读取 EasyWork 版本 Hook", {
          status: 502,
          details: { errors: entry.errors.map((error) => String(error?.message || "hook discovery failed")) },
        });
        const matches = entry.hooks.filter((hook) => CODEX_PRE_TOOL_USE_EVENT_NAMES.has(hook?.eventName)
          && hook?.handlerType === "command"
          && hook?.sourcePath === sourcePath
          && hook?.command === command
          && hook?.statusMessage === INTERNAL_VERSION_HOOK_STATUS);
        invariant(matches.length === 1, "AGENT_CODEX_VERSION_HOOK_MISSING", "Codex 未发现 EasyWork 当前版本的文件快照 Hook", {
          status: 502,
          details: { matched: matches.length },
        });
        const hook = matches[0];
        invariant(typeof hook.key === "string" && hook.key.length > 0
          && typeof hook.currentHash === "string" && /^sha256:[a-f0-9]{64}$/.test(hook.currentHash)
          && ["managed", "untrusted", "trusted", "modified"].includes(hook.trustStatus)
          && hook.enabled === true && hook.isManaged === false,
        "AGENT_CODEX_VERSION_HOOK_INVALID", "Codex EasyWork 文件快照 Hook 元数据无效", { status: 502 });
        return hook;
      };

      let hook = await list();
      if (hook.trustStatus !== "trusted") {
        await process.requestJsonRpc("config/batchWrite", {
          edits: [{
            keyPath: "hooks.state",
            value: {
              [hook.key]: { trusted_hash: hook.currentHash },
            },
            mergeStrategy: "upsert",
          }],
          reloadUserConfig: true,
        });
        hook = await list();
        invariant(hook.trustStatus === "trusted", "AGENT_CODEX_VERSION_HOOK_TRUST_FAILED", "Codex 未能精确信任 EasyWork 文件快照 Hook", {
          status: 502,
        });
      }
      // Persist trust for the one exact Hook definition returned by Codex.
      // This keeps unrelated user or project Hooks under their own trust
      // decisions and avoids the broad request-level bypass on resumed
      // native threads.
      return {
        bypassHookTrust: false,
        compatibilityIssue: null,
      };
    } catch (error) {
      // The managed baseline must satisfy the complete contract.  A manually
      // selected Codex version is still allowed to run when its app-server
      // predates hook discovery; expose the exact lost capability instead of
      // rejecting every other native event from that version.
      if (context.installation.source === "managed") throw error;
      const agentVersion = String(context.installation.version || "unknown");
      return {
        bypassHookTrust: false,
        compatibilityIssue: {
          feature: "version_preimage_hook",
          agentVersion,
          blocking: false,
          eventType: String(error?.code || "hooks/list"),
          message: `Codex ${agentVersion} 不支持 EasyWork 当前的文件变更前快照 Hook；Agent 可以继续运行，但该版本产生的文件修改不能保证完整回溯。`,
        },
      };
    }
  }

  async #executeCodex(context) {
    invariant(["json-rpc", "json-rpc-response"].includes(context.request.descriptor.transport), "AGENT_TRANSPORT_UNSUPPORTED", "Codex operation 需要 JSON-RPC transport", {
      status: 409,
    });
    const operation = context.request.operation;
    const key = activeEntryKey(context.request.binding);
    let previous = this.active.get(key);
    const refreshConfiguration = ["start", "resume"].includes(operation)
      && context.runtimeFingerprint
      && context.runtimeFingerprint !== String(previous?.runtimeFingerprint || "");
    if (refreshConfiguration && previous?.agentId === "codex" && previous.process && !previous.process.closed) {
      // Codex reads approval/sandbox settings when app-server starts. Keep a
      // running turn available for append/interrupt, but never reuse that
      // process for a later turn after its managed configuration changed.
      await previous.process.signal("SIGTERM");
      if (this.active.get(key)?.process === previous.process) this.active.delete(key);
      previous = null;
    }
    const hadLiveProcess = previous?.agentId === "codex" && previous.process && !previous.process.closed;
    if (["append", "interrupt", "respondApproval", "respondInput"].includes(operation) && !hadLiveProcess) {
      throw new ApiError("AGENT_NATIVE_PROCESS_UNAVAILABLE", `Codex ${operation} 必须命中当前 app-server 进程`, {
        status: 409,
        details: { operation },
      });
    }
    const entry = await this.#codexProcess(context);
    entry.operationActive = true;
    this.#touchNativeProcess(entry);
    const processChanged = entry.process !== previous?.process;
    if (processChanged && typeof entry.process.discardBufferedLines === "function") entry.process.discardBufferedLines();
    if (context.request.descriptor.transport === "json-rpc-response") {
      invariant(typeof entry.process.respondJsonRpc === "function", "AGENT_CODEX_APPROVAL_UNSUPPORTED", "Codex process 不支持审批响应", { status: 500, expose: false });
      entry.process.respondJsonRpc(context.request.descriptor.requestId, context.request.descriptor.result || {});
      await this.#recordRuntime(context, {
        runId: nativeRunId(context.request.binding),
        status: "running",
        processId: entry.process.processId,
        threadId: context.request.binding.native?.threadId || context.request.binding.state?.sessionId || null,
      });
      entry.operationActive = false;
      this.#touchNativeProcess(entry);
      return {
        runId: nativeRunId(context.request.binding),
        bindingPatch: {
          native: {
            processId: entry.process.processId,
            runtimeBindingId: context.nativeStoreBindingId,
            runtimeStoreRoot: context.nativeStorePaths.runtimeRoot,
          },
        },
      };
    }
    // Merge adjacent token/tool-input deltas before they enter the raw line
    // queue. A single SSH data chunk can contain thousands of tiny JSONL
    // frames; waiting until after JSON parsing leaves that first queue exposed
    // to a false backpressure overflow even though the logical delta lane is
    // safely coalescible.
    let lines = ["start", "resume"].includes(operation)
      ? entry.process.lines({ merge: agentLineMerger("codex") })
      : null;
    let frameScope = null;
    let appendStartedNewTurn = false;
    const variables = {};
    const nativeThreadId = context.request.binding.native?.threadId || context.request.binding.state?.sessionId;
    const calls = context.request.descriptor.calls || [];
    const loadedThreadIds = entry.loadedThreadIds instanceof Set ? entry.loadedThreadIds : new Set();
    entry.loadedThreadIds = loadedThreadIds;
    if (nativeThreadId
      && !loadedThreadIds.has(String(nativeThreadId))
      && operation !== "resume"
      && calls[0]?.method !== "thread/resume") {
      const cwd = String(context.request.workspace?.path || "").trim();
      const resumed = await entry.process.requestJsonRpc("thread/resume", codexThreadRequestParams({
        threadId: nativeThreadId,
        ...(cwd ? { cwd } : {}),
      }, entry.bypassHookTrust));
      variables["$thread.id"] = String(resumed?.thread?.id || nativeThreadId);
      loadedThreadIds.add(variables["$thread.id"]);
      if (resumed?.thread?.path) variables["$thread.path"] = String(resumed.thread.path);
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(context.request.task?.id || ""))) {
        await this.#bindCodexVersionTask(context, variables["$thread.id"]);
      }
    }
    for (const call of calls) {
      let params = deepSubstitute(call.params || {}, variables);
      if (["thread/start", "thread/resume", "thread/fork"].includes(call.method)) {
        params = codexThreadRequestParams(params, entry.bypassHookTrust);
      }
      if (call.method === "turn/start") {
        // Codex persists the last model and reasoning effort on a native
        // thread. Restarting app-server with a different -c model therefore
        // does not switch an already-resumed thread by itself. The native v2
        // turn/start API explicitly supports sticky model/effort overrides;
        // send the active EasyWork route on every new turn so a configuration
        // change is applied without discarding the native conversation.
        params = codexTurnRequestParams(params, context);
      }
      if (call.method === "turn/start" && context.skills.length) {
        const catalog = await entry.process.requestJsonRpc("skills/list", { cwds: [context.request.workspace?.path || context.paths.runtimeHome], forceReload: true });
        const discovered = (catalog?.data || []).flatMap((group) => group.skills || []);
        const existingInput = Array.isArray(params.input) ? params.input : [];
        const existingSkillPaths = new Set(existingInput
          .filter((item) => item?.type === "skill")
          .map((item) => String(item.path || "")));
        const skillInput = [...new Map(context.skills.map((skill) => {
          const expectedPath = `${skill.remotePath}/SKILL.md`;
          const found = discovered.find((item) => item.path === expectedPath || (item.name === skill.nativeName && String(item.path || "").startsWith(`${context.paths.runtimeRoot}/`)));
          invariant(found, "AGENT_SKILL_NOT_DISCOVERED", `Codex 未发现所选技能 ${skill.nativeName || skill.skillId}`, { status: 409, retryable: true });
          const skillPath = found.path;
          return [skillPath, {
            type: "skill",
            name: String(found.name),
            path: skillPath,
          }];
        })).values()].filter((item) => !existingSkillPaths.has(item.path));
        params = { ...params, input: [...existingInput, ...skillInput] };
      }
      if (call.method === "turn/start"
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(context.request.task?.id || ""))) {
        await this.#bindCodexVersionTask(context, params.threadId || variables["$thread.id"] || nativeThreadId);
      }
      let result;
      try {
        result = await entry.process.requestJsonRpc(call.method, params);
      } catch (error) {
        if (operation !== "append" || call.method !== "turn/steer" || !codexSteerWindowClosed(error)) throw error;
        // The page can still be draining the previous turn's final frames when
        // Codex has already closed its native steer window.  Keep the user
        // message on the same native thread by starting the next turn directly;
        // this remains a native continuation and never re-enters the Web Agent.
        const fallbackParams = codexTurnRequestParams({
          threadId: params.threadId,
          input: Array.isArray(params.input) ? params.input : [],
        }, context);
        variables["$thread.id"] = String(fallbackParams.threadId);
        if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(context.request.task?.id || ""))) {
          await this.#bindCodexVersionTask(context, fallbackParams.threadId);
        }
        // Codex's own TUI handles this race by clearing the stale active turn
        // and starting a new turn on the same thread while retaining its one
        // thread event listener. Repoint the existing scoped stream before
        // turn/start so an early turn/started notification cannot be dropped.
        // A replacement stream is needed only when the prior pump genuinely no
        // longer exists (for example after a process reconstruction).
        const reusableScope = entry.codexFrameScope || null;
        const previousScope = reusableScope
          ? { threadId: reusableScope.threadId, turnId: reusableScope.turnId }
          : null;
        if (reusableScope) {
          frameScope = reusableScope;
        } else {
          lines = entry.process.lines({ merge: agentLineMerger("codex") });
          frameScope = { threadId: "", turnId: "" };
          appendStartedNewTurn = true;
        }
        frameScope.threadId = String(fallbackParams.threadId || "");
        frameScope.turnId = "";
        try {
          result = await entry.process.requestJsonRpc("turn/start", fallbackParams);
        } catch (fallbackError) {
          if (previousScope) Object.assign(frameScope, previousScope);
          throw fallbackError;
        }
        const turnId = result?.turn?.id;
        if (turnId) {
          variables["$turn.id"] = String(turnId);
          frameScope.turnId = String(turnId);
        }
        continue;
      }
      if (["thread/start", "thread/resume", "thread/fork", "thread/revert"].includes(call.method)) {
        const threadId = result?.thread?.id || params.threadId;
        if (threadId) {
          variables["$thread.id"] = String(threadId);
          loadedThreadIds.add(String(threadId));
        }
        if (result?.thread?.path) variables["$thread.path"] = String(result.thread.path);
        if (threadId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(context.request.task?.id || ""))) {
          await this.#bindCodexVersionTask(context, threadId);
        }
      } else if (call.method === "turn/start") {
        const turnId = result?.turn?.id;
        if (turnId) variables["$turn.id"] = String(turnId);
      }
    }
    const runId = ["start", "resume"].includes(operation) || appendStartedNewTurn
      ? createRuntimeRunId(context.agentId, context.bindingId, this.clock)
      : nativeRunId(context.request.binding);
    if (lines) {
      frameScope ||= { threadId: "", turnId: "" };
      frameScope.threadId = String(variables["$thread.id"] || nativeThreadId || "");
      frameScope.turnId = String(variables["$turn.id"] || "");
      entry.codexFrameScope = frameScope;
    }
    const runtimePersistence = this.#recordRuntime(context, {
      runId,
      status: operation === "interrupt" ? "interrupted" : ["fork", "revert"].includes(operation) ? "idle" : "running",
      processId: entry.process.processId,
      threadId: variables["$thread.id"] || nativeThreadId || null,
      rolloutPath: variables["$thread.path"] || context.request.binding.native?.rolloutPath || null,
    }).then(() => null, (error) => error);
    if (!lines) {
      const persistenceError = await runtimePersistence;
      if (persistenceError) throw persistenceError;
    }
    const compatibilityFrames = lines && !entry.compatibilityIssuesAnnounced
      ? (entry.compatibilityIssues || []).map((issue) => ({ method: "easywork/compatibilityIssue", params: issue }))
      : [];
    if (compatibilityFrames.length) entry.compatibilityIssuesAnnounced = true;
    entry.operationActive = false;
    if (!lines) this.#touchNativeProcess(entry);
    return {
      runId,
      bindingPatch: {
        ...(["fork", "revert"].includes(operation) ? {
          state: {
            sessionId: variables["$thread.id"] || nativeThreadId || null,
            turnId: null,
            status: "idle",
          },
        } : {}),
        native: {
          agentSource: context.installation.source,
          binaryPath: context.installation.binaryPath,
          processId: entry.process.processId,
          runtimeRoot: context.paths.runtimeRoot,
          runtimeBindingId: context.nativeStoreBindingId,
          runtimeStoreRoot: context.nativeStorePaths.runtimeRoot,
          skillsRoot: context.paths.skillsRoot,
          ...(variables["$thread.id"] ? { threadId: variables["$thread.id"] } : {}),
          ...(variables["$thread.path"] ? { rolloutPath: variables["$thread.path"] } : {}),
          ...(variables["$turn.id"] ? { turnId: variables["$turn.id"] } : {}),
          ...(["fork", "revert"].includes(operation) ? { turnId: null } : {}),
          ...(entry.runtimeFingerprint ? { runtimeFingerprint: entry.runtimeFingerprint } : {}),
          ...(context.request.__runtimeProxy ? { apiProxy: context.request.__runtimeProxy } : {}),
        },
      },
      ...(lines ? {
        frames: framesWithRequiredPersistence(coalescedAgentFrames(scopedCodexFrames(prefixedFrames(lines, compatibilityFrames), {
          scope: frameScope,
          process: entry.process,
          onClose: () => {
            if (entry.codexFrameScope !== frameScope) return;
            entry.codexFrameScope = null;
            this.#touchNativeProcess(entry);
          },
        }), "codex"), runtimePersistence, context.installation.version),
      } : {}),
    };
  }

  async #claudeCliProfile(context) {
    if (context.installation.source === "managed") return { help: null, issues: [] };
    const isQoder = context.agentId === "qoder-cn";
    const agentLabel = isQoder ? "Qoder CN" : "Claude Code";
    const key = `${context.agentId}\0${context.installation.binaryPath}\0${context.installation.version}`;
    if (this.cliCapabilityProfiles.has(key)) return this.cliCapabilityProfiles.get(key);
    const pending = (async () => {
      const result = await this.executor.exec(`${shellQuote(context.installation.binaryPath)} --help`, { maxOutputBytes: 512 * 1024 });
      const help = `${String(result.stdout || "")}\n${String(result.stderr || "")}`;
      const agentVersion = String(context.installation.version || "unknown");
      if (result.code !== 0 || !help.trim()) {
        return {
          help: null,
          issues: [{
            feature: "cli_capability_probe",
            agentVersion,
            blocking: false,
            eventType: "--help",
            message: `${agentLabel} ${agentVersion} 无法返回参数清单；EasyWork 将按标准 stream-json 参数尝试运行。`,
          }],
        };
      }
      const printFlag = commandHelpHasFlag(help, "-p") || commandHelpHasFlag(help, "--print");
      const missingRequired = [
        ...(!printFlag ? ["-p/--print"] : []),
        ...(!commandHelpHasFlag(help, "--input-format") ? ["--input-format"] : []),
        ...(!commandHelpHasFlag(help, "--output-format") ? ["--output-format"] : []),
      ];
      if (missingRequired.length) {
        throw new ApiError(isQoder ? "AGENT_QODER_STREAM_PROTOCOL_UNAVAILABLE" : "AGENT_CLAUDE_STREAM_PROTOCOL_UNAVAILABLE", `${agentLabel} ${agentVersion} 不支持 EasyWork 所需的 stream-json 协议`, {
          status: 409,
          details: { actualVersion: agentVersion, missingCapabilities: missingRequired },
        });
      }
      return { help, issues: [] };
    })();
    this.cliCapabilityProfiles.set(key, pending);
    try {
      const profile = await pending;
      this.cliCapabilityProfiles.set(key, profile);
      return profile;
    } catch (error) {
      if (this.cliCapabilityProfiles.get(key) === pending) this.cliCapabilityProfiles.delete(key);
      throw error;
    }
  }

  async #claudeArgsForVersion(context, originalArgs) {
    const profile = await this.#claudeCliProfile(context);
    if (!profile.help) return { args: [...originalArgs], issues: [...profile.issues] };
    const help = profile.help;
    const agentVersion = String(context.installation.version || "unknown");
    const isQoder = context.agentId === "qoder-cn";
    const agentLabel = isQoder ? "Qoder CN" : "Claude Code";
    const issues = [...profile.issues];
    const optional = new Map([
      ["--include-partial-messages", false],
      ["--permission-prompt-tool", true],
      ["--verbose", false],
      ["--settings", true],
      ["--model", true],
      ["--effort", true],
      ["--reasoning-effort", true],
      ["--disallowed-tools", true],
      ["--permission-mode", true],
    ]);
    const args = [];
    for (let index = 0; index < originalArgs.length; index += 1) {
      let value = originalArgs[index];
      if (value === "-p" && !commandHelpHasFlag(help, "-p") && commandHelpHasFlag(help, "--print")) value = "--print";
      if (value === "--resume" && !commandHelpHasFlag(help, value)) {
        throw new ApiError(isQoder ? "AGENT_QODER_RESUME_UNAVAILABLE" : "AGENT_CLAUDE_RESUME_UNAVAILABLE", `${agentLabel} ${agentVersion} 不支持恢复原生会话`, {
          status: 409,
          details: { actualVersion: agentVersion, missingCapability: value },
        });
      }
      if (optional.has(value) && !commandHelpHasFlag(help, value)) {
        const takesValue = optional.get(value);
        if (takesValue) index += 1;
        issues.push({
          feature: `cli_flag:${value}`,
          agentVersion,
          blocking: false,
          eventType: value,
          message: `${agentLabel} ${agentVersion} 不支持参数 ${value}；EasyWork 已使用该版本可用的原生能力继续运行。`,
        });
        continue;
      }
      args.push(value);
    }
    return { args, issues };
  }

  async #claudeProcess(context) {
    const key = activeEntryKey(context.request.binding);
    const pendingKey = `${context.agentId}\0${key}`;
    const pending = this.pendingProcessStarts.get(pendingKey);
    if (pending) await pending.catch(() => undefined);
    const start = this.#claudeProcessCurrent(context);
    this.pendingProcessStarts.set(pendingKey, start);
    try {
      const entry = await start;
      this.#touchNativeProcess(entry);
      return entry;
    } finally {
      if (this.pendingProcessStarts.get(pendingKey) === start) this.pendingProcessStarts.delete(pendingKey);
    }
  }

  #claudeEffortCacheKey(context, requestedEffort) {
    const route = context.apiRoute || context.runtimeApiRoute || {};
    return [route.providerId || "provider", route.model || context.configuration.model || "model", requestedEffort].map(String).join("\0");
  }

  #effectiveClaudeEffort(context) {
    if (context.agentId === "qoder-cn") {
      const requested = String(context.configuration.reasoningEffort || "").trim();
      return requested === "default" ? "" : requested;
    }
    const requested = String(context.configuration.effortLevel || "").trim();
    return this.claudeEffortFallbacks.get(this.#claudeEffortCacheKey(context, requested)) || requested;
  }

  #rememberClaudeEffortFallback(context, fallback) {
    if (context.agentId === "qoder-cn") return false;
    const requested = String(context.configuration.effortLevel || "").trim();
    const normalized = String(fallback || "").trim();
    if (!requested || !normalized || requested === normalized) return false;
    this.claudeEffortFallbacks.set(this.#claudeEffortCacheKey(context, requested), normalized);
    return true;
  }

  async #prepareQoderSessionWorkspace(context, sessionId, workspacePath) {
    const nativeSessionId = String(sessionId || "").trim();
    invariant(CLAUDE_NATIVE_UUID.test(nativeSessionId), "AGENT_NATIVE_SESSION_INVALID", "Qoder CN 原生会话 id 无效", {
      status: 409,
      details: { sessionId: nativeSessionId },
    });
    const projectsRoot = `${context.nativeStorePaths.runtimeData}/qoder-cn/projects`;
    const targetProjectKey = qoderProjectKey(workspacePath);
    const preferredProjectKey = String(context.request.binding.native?.sessionProjectKey || "").trim();
    const script = [
      `projects_root=${shellQuote(projectsRoot)}`,
      `session_id=${shellQuote(nativeSessionId)}`,
      `target_key=${shellQuote(targetProjectKey)}`,
      `preferred_key=${shellQuote(preferredProjectKey)}`,
      "source_file=''",
      "fallback_file=''",
      "if [ -n \"$preferred_key\" ] && [ -f \"$projects_root/$preferred_key/$session_id.jsonl\" ]; then source_file=\"$projects_root/$preferred_key/$session_id.jsonl\"; fi",
      "if [ -z \"$source_file\" ]; then",
      "  for candidate in \"$projects_root\"/*/\"$session_id.jsonl\"; do",
      "    [ -f \"$candidate\" ] || continue",
      "    if [ ! -L \"$candidate\" ]; then source_file=\"$candidate\"; break; fi",
      "    [ -n \"$fallback_file\" ] || fallback_file=\"$candidate\"",
      "  done",
      "fi",
      "[ -n \"$source_file\" ] || source_file=\"$fallback_file\"",
      "[ -n \"$source_file\" ] || exit 74",
      "source_file=\"$(readlink -f -- \"$source_file\")\"",
      "[ -f \"$source_file\" ] || exit 74",
      "case \"$source_file\" in \"$projects_root\"/*/\"$session_id.jsonl\") ;; *) exit 73 ;; esac",
      "source_project=\"${source_file%/*}\"",
      "target_project=\"$projects_root/$target_key\"",
      "[ ! -L \"$target_project\" ] || exit 73",
      "mkdir -p -- \"$target_project\"",
      "chmod 0700 -- \"$target_project\"",
      "if [ \"$source_project\" != \"$target_project\" ]; then",
      "  target_file=\"$target_project/$session_id.jsonl\"",
      "  if [ -L \"$target_file\" ]; then",
      "    [ \"$(readlink -f -- \"$target_file\")\" = \"$source_file\" ] || exit 73",
      "  elif [ -e \"$target_file\" ]; then",
      "    [ \"$target_file\" -ef \"$source_file\" ] || exit 73",
      "  else",
      "    ln -s -- \"$source_file\" \"$target_file\" || { [ -L \"$target_file\" ] && [ \"$(readlink -f -- \"$target_file\")\" = \"$source_file\" ]; } || exit 73",
      "  fi",
      "  source_sidecar=\"${source_file%.jsonl}\"",
      "  target_sidecar=\"$target_project/$session_id\"",
      "  if [ -d \"$source_sidecar\" ]; then",
      "    if [ -L \"$target_sidecar\" ]; then",
      "      [ \"$(readlink -f -- \"$target_sidecar\")\" = \"$(readlink -f -- \"$source_sidecar\")\" ] || exit 73",
      "    elif [ -e \"$target_sidecar\" ]; then",
      "      [ \"$target_sidecar\" -ef \"$source_sidecar\" ] || exit 73",
      "    else",
      "      ln -s -- \"$source_sidecar\" \"$target_sidecar\" || { [ -L \"$target_sidecar\" ] && [ \"$(readlink -f -- \"$target_sidecar\")\" = \"$(readlink -f -- \"$source_sidecar\")\" ]; } || exit 73",
      "    fi",
      "  fi",
      "fi",
      "printf '%s\\n' \"${source_project##*/}\"",
    ].join("\n");
    const result = await this.executor.exec(`sh -c ${shellQuote(script)}`, { maxOutputBytes: 512 });
    invariant(result.code !== 74, "AGENT_NATIVE_SESSION_MISSING", "Qoder CN 原生会话记录不存在，无法在新工作区继续", {
      status: 409,
      details: { sessionId: nativeSessionId, workspacePath },
    });
    invariant(result.code === 0, "AGENT_NATIVE_WORKSPACE_MOVE_FAILED", "Qoder CN 无法把原生会话切换到新工作区", {
      status: 502,
      retryable: true,
      details: { sessionId: nativeSessionId, workspacePath, exitCode: result.code },
    });
    return String(result.stdout || "").trim().split(/\s+/)[0] || preferredProjectKey || targetProjectKey;
  }

  async #claudeProcessCurrent(context) {
    const descriptor = context.request.descriptor;
    const key = activeEntryKey(context.request.binding);
    const prepared = this.active.get(key);
    const isQoder = context.agentId === "qoder-cn";
    const streamAgentIds = ["claude-code", "qoder-cn"];
    const workspacePath = String(descriptor.cwd || context.request.workspace?.path || context.paths.runtimeHome);
    const preparedMatchesRuntime = prepared?.runtimeFingerprint === context.runtimeFingerprint
      && prepared?.workspacePath === workspacePath
      && prepared?.nativeStoreBindingId === context.nativeStoreBindingId;
    if (context.request.operation === "prepare" && streamAgentIds.includes(prepared?.agentId) && prepared?.agentId === context.agentId && prepared.prepared === true && prepared.process && !prepared.process.closed) {
      if (preparedMatchesRuntime) return prepared;
      await prepared.process.signal("SIGTERM").catch(() => undefined);
      if (this.active.get(key) === prepared) this.active.delete(key);
    }
    if (context.request.operation === "start"
      && !(Array.isArray(descriptor.args) && descriptor.args.includes("--fork-session"))
      && !(Array.isArray(descriptor.args) && descriptor.args.includes("--resume-session-at"))
      && streamAgentIds.includes(prepared?.agentId) && prepared?.agentId === context.agentId && prepared.prepared === true && prepared.process && !prepared.process.closed) {
      if (preparedMatchesRuntime) {
        prepared.prepared = false;
        return prepared;
      }
      await prepared.process.signal("SIGTERM").catch(() => undefined);
      if (this.active.get(key) === prepared) this.active.delete(key);
    }
    const requestedArgs = [...(descriptor.args || [])];
    const effectiveEffort = this.#effectiveClaudeEffort(context);
    const configuredEffort = String((isQoder ? context.configuration.reasoningEffort : context.configuration.effortLevel) || "").trim();
    if (effectiveEffort && configuredEffort && effectiveEffort !== configuredEffort) {
      this.#queueEffortAdjustment(context, {
        requestedEffort: configuredEffort,
        appliedEffort: effectiveEffort,
        model: context.apiRoute?.model || context.configuration.model || "",
        cached: true,
      });
    }
    if (!requestedArgs.includes("--settings")) requestedArgs.push("--settings", `${context.paths.runtimeData}/${isQoder ? "qoder-cn" : "claude"}/settings.json`);
    if (isQoder) {
      for (const tool of ["CronCreate", "CronDelete", "CronList"]) requestedArgs.push("--disallowed-tools", tool);
    } else requestedArgs.push("--disallowedTools", "CronCreate,CronDelete,CronList");
    if (context.configuration.model) requestedArgs.push("--model", context.configuration.model);
    if (isQoder && Number.isSafeInteger(Number(context.configuration.contextLimit)) && Number(context.configuration.contextLimit) > 0) {
      requestedArgs.push("--context-window", String(context.configuration.contextLimit));
    }
    if (effectiveEffort) requestedArgs.push(isQoder ? "--reasoning-effort" : "--effort", effectiveEffort);
    if (context.configuration.permissionMode) requestedArgs.push("--permission-mode", context.configuration.permissionMode);
    const existingSessionId = context.request.binding.native?.sessionId || context.request.binding.state?.sessionId;
    if (context.request.operation === "start" && existingSessionId && !requestedArgs.includes("--resume")) {
      requestedArgs.push("--resume", String(existingSessionId));
    }
    const resumeArgumentIndex = requestedArgs.lastIndexOf("--resume");
    const resumedSessionId = resumeArgumentIndex >= 0 ? requestedArgs[resumeArgumentIndex + 1] : existingSessionId;
    let sessionProjectKey = null;
    if (isQoder) {
      sessionProjectKey = resumedSessionId
        ? await this.#prepareQoderSessionWorkspace(context, resumedSessionId, workspacePath)
        : qoderProjectKey(workspacePath);
      if (requestedArgs.includes("--fork-session")) sessionProjectKey = qoderProjectKey(workspacePath);
    }
    const versionProfile = await this.#claudeArgsForVersion(context, requestedArgs);
    const args = versionProfile.args;
    const processEnv = processEnvironment(context.environment);
    // Claude Code gives CLAUDE_CODE_EFFORT_LEVEL precedence over settings and
    // CLI flags. A remembered provider compatibility choice is applied to this
    // process immediately and conditionally persisted by the adjustment queue.
    if (!isQoder && effectiveEffort) processEnv.CLAUDE_CODE_EFFORT_LEVEL = effectiveEffort;
    const process = await this.executor.spawn({
      executable: context.installation.binaryPath,
      args,
      cwd: workspacePath,
      env: processEnv,
      envFile: context.runtimeApiRoute ? context.paths.providerEnvironment : null,
    });
    const entry = {
      agentId: context.agentId,
      configScope: context.configScope,
      process,
      paths: context.paths,
      runtimeApiRoute: context.runtimeApiRoute,
      runtimeFingerprint: context.runtimeFingerprint,
      nativeStoreBindingId: context.nativeStoreBindingId,
      workspacePath,
      sessionProjectKey,
      effortLevel: effectiveEffort,
      prepared: false,
      compatibilityIssues: versionProfile.issues,
    };
    this.active.set(key, entry);
    process.wait?.().finally(() => {
      if (this.active.get(key)?.process === process) this.active.delete(key);
      // The SSH relay belongs to the binding, not this one native process.
      // A Skill/configuration change can replace a warmed process after its
      // successor's environment already references the same relay. Closing it
      // here would disconnect that successor (including on a late exit).
      // releaseBinding(), route replacement and close() own relay cleanup.
    }).catch(() => {});
    return entry;
  }

  async #executeClaudeCode(context) {
    const descriptor = context.request.descriptor;
    const operation = context.request.operation;
    const isQoder = context.agentId === "qoder-cn";
    const agentLabel = isQoder ? "Qoder CN" : "Claude Code";
    const configDirectory = isQoder ? "qoder-cn" : "claude";
    const key = activeEntryKey(context.request.binding);
    let entry = this.active.get(key);
    if (operation === "compact" && (!entry?.process || entry.process.closed || entry.process.inputEnded)) {
      // Claude's streaming process normally exits after a completed turn. A
      // later compact request must therefore resume the persisted native
      // session in a fresh process instead of requiring the completed process to
      // remain alive indefinitely.
      const sessionId = context.request.binding.native?.sessionId || context.request.binding.state?.sessionId;
      invariant(sessionId, "AGENT_NATIVE_SESSION_MISSING", `${agentLabel} compact 缺少 native session`, { status: 409 });
      const resumed = {
        ...descriptor,
        transport: "process-jsonl",
        executable: isQoder ? "qoderclicn" : "claude",
        args: [isQoder ? "--print" : "-p", "--input-format", "stream-json", "--output-format", "stream-json", ...(isQoder ? [] : ["--verbose"]), "--include-partial-messages", "--resume", String(sessionId)],
        cwd: descriptor.cwd || context.request.workspace?.path,
        stdin: descriptor.frames || [],
      };
      delete resumed.frames;
      context = { ...context, request: { ...context.request, descriptor: resumed } };
      entry = null;
    }
    const effectiveDescriptor = structuredClone(context.request.descriptor);
    const oneShotCompact = operation === "compact" && effectiveDescriptor.transport === "process-jsonl";
    if (context.nativeSkillCommand && ["start", "resume"].includes(operation)) {
      for (const frame of effectiveDescriptor.stdin || []) {
        if (frame.type === "user" && typeof frame.message?.content === "string") frame.message.content = `/${context.nativeSkillCommand.name} ${frame.message.content}`;
        else if (frame.type === "user" && Array.isArray(frame.message?.content)) {
          const text = frame.message.content.find((part) => part.type === "text");
          if (text) text.text = `/${context.nativeSkillCommand.name} ${text.text}`;
        }
      }
    }
    if (effectiveDescriptor.transport === "process-jsonl") {
      entry = await this.#claudeProcess(context);
      const sessionBeforeTurn = context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null;
      let previousTurnId = context.request.binding.native?.turnId
        || context.request.binding.state?.turnId
        || context.request.binding.native?.pendingRewind?.resumeSessionAt
        || context.request.binding.native?.pendingFork?.resumeSessionAt
        || null;
      // Bindings created before native leaf capture was introduced can have a
      // valid Claude session but no stored turn boundary. Snapshot that one
      // pre-turn leaf before stdin is written, so the post-result resolver
      // cannot mistake an older last-prompt record for this turn's answer.
      if (!previousTurnId && sessionBeforeTurn) {
        previousTurnId = await claudeTranscriptCurrentLeafUuid({
          executor: this.executor,
          runtimeData: context.nativeStorePaths.runtimeData,
          sessionId: sessionBeforeTurn,
          configDirectory,
        });
      }
      if (operation === "compact") {
        await executeClaudeCompact({
          entry,
          frames: effectiveDescriptor.stdin,
          agentLabel,
          terminateAfter: oneShotCompact,
        });
        await this.#recordRuntime(context, {
          runId: nativeRunId(context.request.binding),
          status: "idle",
          processId: entry.process.processId,
          sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
        });
        return {
          runId: nativeRunId(context.request.binding),
          bindingPatch: {
            native: {
              agentSource: context.installation.source,
              binaryPath: context.installation.binaryPath,
              runtimeRoot: context.paths.runtimeRoot,
              runtimeBindingId: context.nativeStoreBindingId,
              runtimeStoreRoot: context.nativeStorePaths.runtimeRoot,
              skillsRoot: context.paths.skillsRoot,
              ...(isQoder ? { sessionProjectKey: entry.sessionProjectKey, workspacePath: entry.workspacePath } : {}),
            },
          },
        };
      }
      for (const frame of effectiveDescriptor.stdin || []) writeClaudeFrame(entry, frame);
      const runId = createRuntimeRunId(context.agentId, context.bindingId, this.clock);
      const runtimePersistence = this.#recordRuntime(context, {
        runId,
        status: "running",
        processId: entry.process.processId,
        sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
      }).then(() => null, (error) => error);
      const lines = entry.process.lines(agentLineQueueOptions(context.agentId));
      const compatibilityFrames = !entry.compatibilityIssuesAnnounced
        ? (entry.compatibilityIssues || []).map((issue) => ({ type: "easywork_compatibility_issue", issue }))
        : [];
      if (compatibilityFrames.length) entry.compatibilityIssuesAnnounced = true;
      const submittedBeforeRecovery = claudeTurnQueue(entry).submitted;
      const firstEntry = entry;
      const scopedFrames = scopedClaudeFrames(prefixedFrames(lines, compatibilityFrames), entry);
      const effortFrames = isQoder ? scopedFrames : adaptiveClaudeEffortFrames(scopedFrames, {
        requestedEffort: entry.effortLevel || context.configuration.effortLevel,
        retry: async (fallback) => {
          // Replaying is safe only before any mid-run user append joined this
          // process. Otherwise automatic recovery could silently drop or
          // duplicate a queued user instruction.
          if (claudeTurnQueue(firstEntry).submitted !== submittedBeforeRecovery) return null;
          if (!this.#rememberClaudeEffortFallback(context, fallback)) return null;
          if (!firstEntry.process.closed) await firstEntry.process.signal("SIGTERM").catch(() => undefined);
          const persistenceError = await runtimePersistence;
          if (persistenceError) throw persistenceError;
          const retryEntry = await this.#claudeProcess(context);
          retryEntry.preparedRuntime = firstEntry.preparedRuntime || null;
          for (const frame of effectiveDescriptor.stdin || []) writeClaudeFrame(retryEntry, frame);
          await this.#recordRuntime(context, {
            runId,
            status: "running",
            processId: retryEntry.process.processId,
            sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
          });
          return scopedClaudeFrames(retryEntry.process.lines(agentLineQueueOptions(context.agentId)), retryEntry);
        },
      });
      return {
        runId,
        bindingPatch: {
          native: {
            agentSource: context.installation.source,
            binaryPath: context.installation.binaryPath,
            processId: entry.process.processId,
            runtimeRoot: context.paths.runtimeRoot,
            runtimeBindingId: context.nativeStoreBindingId,
            runtimeStoreRoot: context.nativeStorePaths.runtimeRoot,
            skillsRoot: context.paths.skillsRoot,
            ...(isQoder ? { sessionProjectKey: entry.sessionProjectKey, workspacePath: entry.workspacePath } : {}),
            ...(context.request.__runtimeProxy ? { apiProxy: context.request.__runtimeProxy } : {}),
          },
        },
        frames: framesWithRequiredPersistence(coalescedAgentFrames(claudeFramesWithNativeBoundary(
          effortFrames,
          {
            executor: this.executor,
            runtimeData: context.nativeStorePaths.runtimeData,
            sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
            previousTurnId,
            configDirectory,
          },
        ), context.agentId), runtimePersistence, context.installation.version),
      };
    }
    invariant(entry?.agentId === context.agentId && entry.process && !entry.process.closed && !entry.process.inputEnded, "AGENT_NATIVE_PROCESS_UNAVAILABLE", `${agentLabel} 原生进程已不可用`, {
      status: 409,
      details: { operation },
    });
    if (effectiveDescriptor.transport === "process-jsonl-stdin") {
      if (operation === "interrupt") {
        const frame = (effectiveDescriptor.frames || [])[0];
        try {
          if (typeof entry.process.requestControl === "function") await entry.process.requestControl(frame);
          else entry.process.writeJson(frame);
        } catch {
          // Older Claude Code builds may not acknowledge the native control
          // frame. Fall back to the exact scoped process only after the native
          // protocol had a chance to stop its active tool tree.
          if (!entry.process.closed) await entry.process.signal("SIGINT");
        }
        if (!entry.process.closed) await entry.process.signal("SIGTERM");
        if (!await confirmProcessExit(entry.process, 4_000)) {
          await entry.process.signal("SIGKILL");
          invariant(await confirmProcessExit(entry.process, 2_000), "AGENT_INTERRUPT_TIMEOUT", `${agentLabel} 中断后仍未退出，可重试停止`, { status: 504, retryable: true });
        }
        if (this.active.get(key)?.process === entry.process) this.active.delete(key);
      } else if (operation === "compact") {
        await executeClaudeCompact({
          entry,
          frames: effectiveDescriptor.frames,
          agentLabel,
        });
      } else {
        for (const frame of effectiveDescriptor.frames || []) writeClaudeFrame(entry, frame);
      }
    } else if (effectiveDescriptor.transport === "process-signal") {
      invariant(String(effectiveDescriptor.processId) === String(entry.process.processId), "AGENT_NATIVE_PROCESS_MISMATCH", `interrupt 未命中当前 ${agentLabel} 进程`, {
        status: 409,
      });
      await entry.process.signal(effectiveDescriptor.signal || "SIGINT");
      // A signal acknowledgement only proves delivery. Bound the wait for the
      // process to actually leave and escalate within the same scoped process
      // handle so interrupt can never strand the Task in `interrupting`.
      if (entry.process.detached === false) {
        const waitForExit = (timeoutMs) => Promise.race([
          entry.process.wait?.() || Promise.resolve(),
          new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (await waitForExit(4_000) === null && !entry.process.closed) {
          await entry.process.signal("SIGTERM");
          if (await waitForExit(4_000) === null && !entry.process.closed) {
            await entry.process.signal("SIGKILL");
            invariant(await waitForExit(2_000) !== null || entry.process.closed, "AGENT_INTERRUPT_TIMEOUT", `${agentLabel} 未在中断后及时退出`, { status: 504, retryable: true });
          }
        }
      }
    } else {
      return unsupportedCapability(context.agentId, operation, effectiveDescriptor.transport);
    }
    await this.#recordRuntime(context, {
      runId: nativeRunId(context.request.binding),
      status: operation === "interrupt" || effectiveDescriptor.transport === "process-signal" ? "interrupted" : operation === "compact" ? "idle" : "running",
      processId: entry.process.processId,
      sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
    });
    return {
      runId: nativeRunId(context.request.binding),
      bindingPatch: {
        native: {
          agentSource: context.installation.source,
          binaryPath: context.installation.binaryPath,
          processId: entry.process.processId,
          runtimeRoot: context.paths.runtimeRoot,
          runtimeBindingId: context.nativeStoreBindingId,
          runtimeStoreRoot: context.nativeStorePaths.runtimeRoot,
          skillsRoot: context.paths.skillsRoot,
          ...(isQoder ? { sessionProjectKey: entry.sessionProjectKey, workspacePath: entry.workspacePath } : {}),
        },
      },
    };
  }
}

export { agentLineMerger, agentLineQueueOptions, coalescedAgentFrames, deepSubstitute, frameFromLine, parsedFrames, servicePort };
