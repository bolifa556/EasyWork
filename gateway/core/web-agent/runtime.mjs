import { randomUUID } from "node:crypto";

import { redactSensitive } from "../errors.mjs";
import {
  normalizeWebAgentFragment,
  renderWebAgentObservations,
  webAgentCandidateId,
} from "./observations.mjs";
import { renderSemanticContext } from "./tools.mjs";

const DEFAULT_LIMITS = Object.freeze({
  maxIterations: 96,
  maxToolCalls: 128,
  maxWallTimeMs: 30 * 60_000,
  toolTimeoutMs: 35_000,
  maxInputTokens: 160_000,
  maxOutputTokens: 32_000,
});

function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function normalizedModelResult(value = {}) {
  return {
    content: String(value.content || ""),
    reasoning: String(value.reasoning || ""),
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.map((call, index) => ({
          id: String(call?.id || `call_${index + 1}`),
          name: String(call?.name || ""),
          input: call?.input && typeof call.input === "object" ? call.input : {},
          invalidArguments: call?.invalidArguments === true,
        }))
      : [],
    usage: value.usage && typeof value.usage === "object" ? value.usage : null,
  };
}

const TOOL_CALL_ENVELOPE_KEYS = new Set([
  "id", "type", "name", "parameters", "arguments", "input", "function", "tool_call_id",
]);

function serializedArguments(value) {
  if (value === undefined) return true;
  if (value && typeof value === "object" && !Array.isArray(value)) return true;
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch { return false; }
}

function parsedArguments(value) {
  if (value === undefined) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function toolProtocolShape(value, availableToolNames) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => toolProtocolShape(entry, availableToolNames));
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value.tool_calls) || Array.isArray(value.toolCalls)) {
    const keys = Object.keys(value);
    if (keys.some((key) => !["tool_calls", "toolCalls"].includes(key))) return false;
    const calls = Array.isArray(value.tool_calls) ? value.tool_calls : value.toolCalls;
    return calls.length > 0 && calls.every((entry) => toolProtocolShape(entry, availableToolNames));
  }
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => key === "candidateIds")) {
    return availableToolNames.has("handoff_submit") && Array.isArray(value.candidateIds);
  }
  if (!keys.length || keys.some((key) => !TOOL_CALL_ENVELOPE_KEYS.has(key))) return false;
  const fn = value.function && typeof value.function === "object" && !Array.isArray(value.function)
    ? value.function
    : null;
  if (fn && Object.keys(fn).some((key) => !["name", "arguments"].includes(key))) return false;
  const name = String(value.name || fn?.name || "");
  if (!availableToolNames.has(name)) return false;
  return serializedArguments(value.parameters)
    && serializedArguments(value.arguments)
    && serializedArguments(value.input)
    && serializedArguments(fn?.arguments);
}

function serializedToolProtocol(value, availableToolNames) {
  const content = String(value || "").trim();
  if (!content || !["{", "["].includes(content[0])) return false;
  try { return toolProtocolShape(JSON.parse(content), availableToolNames); } catch { return false; }
}

function serializedToolCalls(value, availableToolNames) {
  const content = String(value || "").trim();
  if (!content || !["{", "["].includes(content[0])) return [];
  let parsed;
  try { parsed = JSON.parse(content); } catch { return []; }
  if (!toolProtocolShape(parsed, availableToolNames)) return [];

  const visit = (entry) => {
    if (Array.isArray(entry)) return entry.flatMap(visit);
    if (Array.isArray(entry.tool_calls) || Array.isArray(entry.toolCalls)) {
      return (Array.isArray(entry.tool_calls) ? entry.tool_calls : entry.toolCalls).flatMap(visit);
    }
    if (Array.isArray(entry.candidateIds)) {
      return [{ name: "handoff_submit", input: { candidateIds: entry.candidateIds.map(String) } }];
    }
    const fn = entry.function && typeof entry.function === "object" && !Array.isArray(entry.function)
      ? entry.function
      : null;
    const name = String(entry.name || fn?.name || "");
    const rawInput = entry.input ?? entry.parameters ?? entry.arguments ?? fn?.arguments;
    const input = parsedArguments(rawInput);
    return input && availableToolNames.has(name) ? [{ name, input, suppliedId: entry.id || entry.tool_call_id || null }] : [];
  };
  return visit(parsed);
}

function recoveredSerializedToolCalls(reasoning, content, availableToolNames, iteration) {
  const seen = new Set();
  const recovered = [];
  for (const value of [reasoning, content]) {
    for (const call of serializedToolCalls(value, availableToolNames)) {
      const identity = `${call.name}\0${stableJson(call.input)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      recovered.push({
        id: String(call.suppliedId || `recovered_${iteration}_${recovered.length + 1}`),
        name: call.name,
        input: call.input,
        invalidArguments: false,
      });
    }
  }
  return recovered;
}

function workProtocolOnly(reasoning, content, availableToolNames) {
  const values = [reasoning, content].map((value) => String(value || "").trim()).filter(Boolean);
  return values.length > 0 && values.every((value) => serializedToolProtocol(value, availableToolNames));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function addCandidate(pool, value, { required = false } = {}) {
  const normalized = normalizeWebAgentFragment({ ...value, required: required || Boolean(value?.required) });
  if (!normalized) return null;
  const candidateId = normalized.candidateId || webAgentCandidateId(normalized);
  if (!candidateId) return null;
  const knowledgeKey = String(normalized?.knowledge?.key || "");
  if (knowledgeKey) {
    // One stable source key has one active version in a model call. Old
    // versions remain in the durable observation ledger for rewind/audit, but
    // presenting both would create an avoidable conflict and could send both
    // to the remote Agent.
    for (const [existingId, existing] of pool) {
      if (existingId !== candidateId && String(existing?.knowledge?.key || "") === knowledgeKey) pool.delete(existingId);
    }
  }
  const current = pool.get(candidateId);
  if (!current
    || normalized.priority > Number(current.priority || 0)
    || normalized.required && !current.required) {
    pool.set(candidateId, {
      ...normalized,
      candidateId,
      required: Boolean(current?.required || normalized.required),
    });
  }
  return pool.get(candidateId);
}

async function workToolResult(fragments, rendered, prompts, presentation) {
  if (!fragments.length) return rendered || await prompts.webToolResult("emptyResult");
  const blocks = await Promise.all(fragments.map((fragment) => prompts.webToolResult("candidateItem", {
    CANDIDATE_ID: fragment.candidateId,
    CONTENT: fragment.rendered || fragment.knowledge?.content || "",
  })));
  return blocks.filter(Boolean).join(presentation.sectionSeparator);
}

const MAX_HANDOFF_CHARACTERS = 48_000;

function normalizedHandoff(value, truncationSuffix) {
  const text = String(value || "").trim();
  return text.length > MAX_HANDOFF_CHARACTERS
    ? `${text.slice(0, MAX_HANDOFF_CHARACTERS).trimEnd()}${String(truncationSuffix || "")}`
    : text;
}

function mergedPresentation(fragments) {
  const merged = {};
  for (const fragment of fragments) {
    for (const name of ["memory", "resources", "conversation", "skills"]) {
      const values = fragment?.presented?.[name];
      if (!Array.isArray(values) || !values.length) continue;
      merged[name] = [...(merged[name] || []), ...values];
    }
  }
  return merged;
}

function handoffFactAnchors(fragment) {
  const content = String(fragment?.knowledge?.content || fragment?.rendered || "").normalize("NFKC");
  const matches = content.match(/[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)+|\b\d{2,}(?:\.\d+)?\b/gu) || [];
  return new Set(matches.map((value) => value.toLocaleLowerCase("en-US")));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function subsetOf(left, right) {
  return [...left].every((value) => right.has(value));
}

function deduplicateHandoffFragments(fragments) {
  const entries = fragments.map((fragment) => ({ fragment, anchors: handoffFactAnchors(fragment) }));
  return entries.filter(({ fragment, anchors }) => {
    const key = String(fragment?.knowledge?.key || "");
    if (!key.startsWith("memory:") || !anchors.size) return true;
    const sameFactEntries = entries.filter(({ fragment: candidate, anchors: candidateAnchors }) => (
      String(candidate?.knowledge?.key || "").startsWith("memory:")
      && sameSet(candidateAnchors, anchors)
    ));
    const preferred = sameFactEntries.reduce((current, candidate) => {
      const currentPriority = Number(current.fragment?.priority || 0);
      const candidatePriority = Number(candidate.fragment?.priority || 0);
      if (candidatePriority !== currentPriority) return candidatePriority > currentPriority ? candidate : current;
      const currentLength = String(current.fragment?.knowledge?.content || "").length;
      const candidateLength = String(candidate.fragment?.knowledge?.content || "").length;
      return candidateLength > currentLength ? candidate : current;
    }, sameFactEntries[0]);
    if (preferred?.fragment !== fragment) return false;
    // A file excerpt can already contain a complete, versioned fact that was
    // later echoed into memory.  When at least two stable anchors prove that
    // containment, keep the higher-priority source excerpt and avoid sending
    // the derived memory paraphrase as duplicate context.
    if (anchors.size < 2) return true;
    return !entries.some(({ fragment: candidate, anchors: candidateAnchors }) => (
      String(candidate?.knowledge?.key || "").startsWith("resource:")
      && Number(candidate?.priority || 0) > Number(fragment?.priority || 0)
      && subsetOf(anchors, candidateAnchors)
    ));
  }).map(({ fragment }) => fragment);
}

async function handoffPresentation(fragments, prompts, presentation) {
  const renderRaw = (entries) => renderSemanticContext(mergedPresentation(entries), prompts, { maxCharacters: Number.MAX_SAFE_INTEGER });
  const render = async (entries) => normalizedHandoff(await renderRaw(entries), presentation.truncationSuffix);
  // Display text is bounded below, but semantic candidates must not disappear
  // merely because the timeline preview is long. ContextHub owns the actual
  // remote token budget and records exactly which complete units were sent.
  const delivered = deduplicateHandoffFragments(fragments);
  // Skill entrypoints are read only so the Web Agent can judge applicability.
  // A selected immutable package is materialized through the remote Agent's
  // native Skill discovery path; SKILL.md is never staged into the ordinary
  // prompt. Keep the body out of the visible handoff while preserving the
  // selected fragment long enough for the host to pin the exact package.
  const contextual = delivered.filter((entry) => entry.toolName !== "skill_search");
  const references = [];
  const referenceIndexes = new Map();
  for (const fragment of delivered) {
    const kind = String(fragment?.reference?.kind || "").trim();
    const name = String(fragment?.reference?.name || "").trim();
    const key = `${kind}\0${name}`;
    if (!kind || !name) continue;
    const detail = kind.toLocaleLowerCase() === "skill"
      ? ""
      : String(fragment?.knowledge?.content || "").trim();
    const knownIndex = referenceIndexes.get(key);
    if (knownIndex !== undefined) {
      if (detail) {
        const current = String(references[knownIndex].detail || "").trim();
        if (!current) references[knownIndex].detail = detail;
        else if (!current.includes(detail)) references[knownIndex].detail = `${current}\n\n${detail}`;
      }
      continue;
    }
    referenceIndexes.set(key, references.length);
    references.push({ kind, name, ...(detail ? { detail } : {}) });
  }
  const skills = [];
  const seenSkills = new Set();
  for (const fragment of delivered) {
    if (fragment.toolName !== "skill_search") continue;
    for (const value of Array.isArray(fragment.presented?.skills) ? fragment.presented.skills : []) {
      const name = String(value?.name || value?.displayName || "").trim();
      const description = String(value?.description || "").trim();
      const key = `${name}\0${description}`;
      if (!name || seenSkills.has(key)) continue;
      seenSkills.add(key);
      skills.push({ name, description });
    }
  }
  return {
    content: await render(contextual),
    displayBrief: await render(contextual.filter((entry) => !entry.reference)),
    references,
    skills,
    fragments: delivered,
  };
}

export class WebAgentRuntime {
  constructor({ model, tools, prompts, limits = {}, eventSink = async () => undefined }) {
    if (!model || typeof model.complete !== "function") throw new TypeError("Web Agent model.complete is required");
    if (!tools || typeof tools.resolve !== "function") throw new TypeError("Web Agent tool registry is required");
    this.model = model;
    this.tools = tools;
    this.prompts = prompts;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.eventSink = eventSink;
  }

  async run({
    mode,
    actor,
    scope,
    userMessage,
    context = [],
    initialObservationFragments = [],
    initialHandoffFragments = [],
    requiredHandoffFragments = [],
    observationSink = null,
    observationFilter = null,
    signal,
    runId = `web_${randomUUID()}`,
    handoffFilter = null,
    emitStarted = true,
    skipModel = false,
  }) {
    if (!['chat', 'work'].includes(mode)) throw new TypeError("Unknown Web Agent mode");
    const runTimeout = AbortSignal.timeout(this.limits.maxWallTimeMs);
    const runSignal = combineSignals(signal, runTimeout);
    const emit = async (kind, payload = {}) => {
      await this.eventSink({
        eventId: `evt_${randomUUID()}`,
        producer: "web-agent",
        runId,
        kind,
        occurredAt: new Date().toISOString(),
        payload,
      });
    };
    if (emitStarted) await emit("run.started", { mode });
    let toolCallCount = 0;
    let finalContent = "";
    let reasoning = "";
    let usage = null;
    const discardedReasoningIterations = new Set();
    const candidatePool = new Map();
    const requiredHandoffPool = new Map();
    const toolCache = new Map();
    const filterObservations = async (fragments) => {
      const values = Array.isArray(fragments) ? fragments : [];
      if (mode !== "work" || typeof observationFilter !== "function" || !values.length) return values;
      const filtered = await observationFilter(values.map((entry) => structuredClone(entry)));
      return Array.isArray(filtered) ? filtered : values;
    };
    const visibleInitialObservations = await filterObservations(initialObservationFragments);
    const visibleInitialHandoff = await filterObservations(initialHandoffFragments);
    for (const fragment of Array.isArray(requiredHandoffFragments) ? requiredHandoffFragments : []) {
      addCandidate(requiredHandoffPool, fragment, { required: true });
    }
    for (const fragment of visibleInitialObservations) addCandidate(candidatePool, fragment);
    for (const fragment of visibleInitialHandoff) addCandidate(candidatePool, fragment, { required: true });
    try {
      if (typeof observationSink === "function" && visibleInitialHandoff.length) {
        await observationSink(visibleInitialHandoff.map((entry) => structuredClone(entry)));
      }
      const presentation = await this.prompts.webToolPresentation();
      const completeWork = async (iterations, candidateIds = []) => {
        const requested = new Set((Array.isArray(candidateIds) ? candidateIds : []).map(String));
        const selectedPool = new Map();
        for (const entry of requiredHandoffPool.values()) addCandidate(selectedPool, entry, { required: true });
        for (const entry of candidatePool.values()) {
          if (entry.required || requested.has(entry.candidateId)) addCandidate(selectedPool, entry, { required: entry.required });
        }
        const selected = [...selectedPool.values()];
        const collected = await handoffPresentation(selected, this.prompts, presentation);
        const acceptedFragments = typeof handoffFilter === "function"
          ? await handoffFilter(collected.fragments.map((entry) => structuredClone(entry)))
          : collected.fragments;
        const selectedFragments = Array.isArray(acceptedFragments) ? acceptedFragments : collected.fragments;
        const handoff = await handoffPresentation(selectedFragments, this.prompts, presentation);
        finalContent = handoff.content;
        await emit("run.handoff.ready", {
          userMessage: String(userMessage || ""),
          contextBrief: handoff.content,
          displayBrief: handoff.displayBrief,
          references: handoff.references,
          skills: handoff.skills,
          ...(discardedReasoningIterations.size
            ? { discardedReasoningIterations: [...discardedReasoningIterations].sort((left, right) => left - right) }
            : {}),
        });
        await emit("run.context.completed", { usage });
        return {
          runId,
          content: handoff.content,
          reasoning,
          usage,
          iterations,
          toolCallCount,
          handoffFragments: handoff.fragments.map((entry) => structuredClone(entry)),
          selectedHandoffFragments: collected.fragments.map((entry) => structuredClone(entry)),
          collectedHandoffFragments: collected.fragments.map((entry) => structuredClone(entry)),
          observedFragments: [...candidatePool.values()].map((entry) => structuredClone(entry)),
        };
      };
      if (mode === "work" && skipModel) {
        return completeWork(0);
      }
      const availableTools = this.tools.definitions(mode);
      const availableToolNames = new Set(availableTools.map((tool) => String(tool.name || "")).filter(Boolean));
      const onlySubmitAvailable = mode === "work"
        && availableTools.length === 1
        && availableTools[0].name === "handoff_submit";
      if (onlySubmitAvailable && candidatePool.size === 0) {
        // There is no contextual choice to make. Calling a provider merely to
        // return handoff_submit([]) adds latency and often produces repetitive
        // reasoning about absent tools. The original user request still goes
        // through the normal remote dispatch path with an empty context delta.
        return completeWork(0);
      }
      const system = await this.prompts.system(mode, { onlySubmitAvailable });
      const currentRequest = mode === "work"
        ? await this.prompts.workRequest(userMessage)
        : String(userMessage || "");
      const observedContext = await renderWebAgentObservations([...candidatePool.values()], mode, this.prompts);
      const messages = [
        { role: "system", content: system },
        ...context,
        ...(observedContext ? [{ role: "system", content: observedContext }] : []),
        { role: "user", content: currentRequest },
      ];
      let forceSubmit = false;
      for (let iteration = 0; iteration < this.limits.maxIterations; iteration += 1) {
        runSignal.throwIfAborted();
        const forcedSubmitAttempt = mode === "work" && forceSubmit;
        let streamedContent = "";
        let streamedReasoning = "";
        let streamedOutput = false;
        const segmentId = `${runId}:output:${iteration}`;
        const rawResult = await this.model.complete({
              mode,
              messages,
              tools: availableTools,
              ...(mode === "work" ? { toolChoice: forceSubmit || onlySubmitAvailable ? "handoff_submit" : "required" } : {}),
              limits: {
                maxInputTokens: this.limits.maxInputTokens,
                maxOutputTokens: this.limits.maxOutputTokens,
              },
              signal: runSignal,
              onDelta: async (delta) => {
                if (delta.kind === "reasoning" && delta.content) {
                  streamedReasoning += delta.content;
                  await emit("run.reasoning.delta", { content: delta.content, iteration });
                }
                if (delta.kind === "content" && delta.content) {
                  streamedContent += delta.content;
                  streamedOutput = true;
                  if (mode === "chat") {
                    await emit("run.output.delta", {
                      content: delta.content,
                      iteration,
                      segmentId,
                      provisional: true,
                      target: "final",
                    });
                  }
                }
              },
            });
        const result = normalizedModelResult(rawResult);
        usage = result.usage || usage;
        const nextReasoning = streamedReasoning || result.reasoning;
        const nextContent = streamedContent || result.content;
        if (mode === "work" && !result.toolCalls.length) {
          const recoveredCalls = recoveredSerializedToolCalls(nextReasoning, nextContent, availableToolNames, iteration);
          if (recoveredCalls.length) {
            // Some OpenAI-compatible providers serialize a legal tool call into
            // reasoning/content instead of native tool_calls. Recover only the
            // strict protocol shapes already validated against this run's tool
            // registry, and keep the wire object out of visible thought text.
            result.toolCalls = recoveredCalls;
            discardedReasoningIterations.add(iteration);
          } else if (workProtocolOnly(nextReasoning, nextContent, availableToolNames)) {
            discardedReasoningIterations.add(iteration);
          }
        }
        if (nextReasoning) {
          reasoning += nextReasoning;
          if (!streamedReasoning) await emit("run.reasoning.delta", { content: nextReasoning, iteration });
        }
        if (mode === "chat" && nextContent && !streamedOutput) {
          await emit("run.output.delta", {
            content: nextContent,
            iteration,
            segmentId,
            provisional: true,
            target: "final",
          });
        }
        if (!result.toolCalls.length) {
          if (mode === "work") {
            if (forceSubmit) {
              // A provider can ignore even a named tool choice. Selection is
              // advisory: required fragments still travel, while unselected
              // observations stay local and the original user request can
              // continue to the remote Agent without a fabricated answer.
              return completeWork(iteration + 1, []);
            }
            forceSubmit = true;
            continue;
          } else {
            if (nextContent) finalContent += nextContent;
            if (nextContent) await emit("run.output.committed", { iteration, segmentId, target: "final" });
            await emit("run.completed", { usage });
          }
          return {
            runId,
            content: finalContent,
            reasoning,
            usage,
            iterations: iteration + 1,
            toolCallCount,
            observedFragments: [...candidatePool.values()].map((entry) => structuredClone(entry)),
          };
        }
        if (mode === "chat" && nextContent) await emit("run.output.committed", { iteration, segmentId, target: "activity" });
        messages.push({
          role: "assistant",
          content: nextContent,
          reasoning: nextReasoning,
          toolCalls: result.toolCalls,
        });
        const supplementalModelMessages = [];
        const hasTerminalCalls = result.toolCalls.some((call) => this.tools.resolve(call.name, mode)?.terminal === true);
        const hasNonTerminalCalls = result.toolCalls.some((call) => this.tools.resolve(call.name, mode)?.terminal !== true);
        if (mode === "work" && hasTerminalCalls && hasNonTerminalCalls) {
          // Work selection is an atomic state transition: a model must either
          // inspect more material or submit the candidates it already has. A
          // provider that serializes both choices into one batch must not make
          // the speculative reads observable before its submit decision wins.
          // Answer every tool call to keep the provider protocol balanced,
          // then narrow the retry to the terminal operation.
          for (const call of result.toolCalls) {
            toolCallCount += 1;
            if (toolCallCount > this.limits.maxToolCalls) throw new Error("Web Agent exceeded tool-call budget");
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: await this.prompts.webToolResult("candidateMixed"),
            });
          }
          forceSubmit = true;
          continue;
        }
        let terminalArgumentsFailed = false;
        let submittedCandidateIds = null;
        for (const call of result.toolCalls) {
          runSignal.throwIfAborted();
          toolCallCount += 1;
          if (toolCallCount > this.limits.maxToolCalls) throw new Error("Web Agent exceeded tool-call budget");
          const tool = this.tools.resolve(call.name, mode);
          if (!tool) {
            // A model can occasionally hallucinate an unavailable tool name.
            // Treat that as a recoverable tool result so it can correct itself
            // on the next iteration instead of aborting the whole user turn.
            const unavailableName = String(call.name || "unknown").slice(0, 160);
            const toolError = {
              code: "TOOL_UNAVAILABLE",
              message: await this.prompts.webToolResult("toolUnavailable", { TOOL_NAME: unavailableName }),
              retryable: true,
            };
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: unavailableName,
              content: await this.prompts.webToolResult("failedResult", { ERROR_MESSAGE: toolError.message }),
            });
            continue;
          }
          if (call.invalidArguments) {
            const message = await this.prompts.webToolResult("invalidToolArguments");
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: await this.prompts.webToolResult("failedResult", { ERROR_MESSAGE: message }),
            });
            if (mode === "work" && tool.terminal) {
              terminalArgumentsFailed = true;
              forceSubmit = true;
            }
            continue;
          }
          let input;
          try {
            input = tool.validate(call.input);
          } catch (error) {
            const fallbackMessage = await this.prompts.webToolResult("invalidToolInput");
            const toolError = {
              code: String(error?.code || "TOOL_INPUT_INVALID"),
              message: String(redactSensitive(String(error?.message || fallbackMessage))).slice(0, 16_384),
              retryable: true,
            };
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: await this.prompts.webToolResult("failedResult", { ERROR_MESSAGE: toolError.message }),
            });
            continue;
          }
          if (tool.terminal) {
            if (hasNonTerminalCalls) {
              messages.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: await this.prompts.webToolResult("candidateMixed"),
              });
              forceSubmit = true;
              continue;
            }
            const unknown = input.candidateIds.filter((candidateId) => !candidatePool.has(candidateId));
            if (unknown.length) {
              messages.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: await this.prompts.webToolResult("candidateUnknown", { CANDIDATE_IDS: unknown.join("、") }),
              });
              forceSubmit = true;
              continue;
            }
            submittedCandidateIds = input.candidateIds;
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "" });
            continue;
          }
          const idempotencyKey = `${runId}:${call.id}`;
          const toolSignal = combineSignals(runSignal, AbortSignal.timeout(this.limits.toolTimeoutMs));
          try {
            const cacheKey = `${call.name}\0${stableJson(input)}`;
            const cached = toolCache.get(cacheKey);
            if (cached) {
              messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: cached.content });
              continue;
            }
            const rawOutput = await tool.execute({ actor, scope, input, idempotencyKey, signal: toolSignal });
            const pruned = tool.prune({
              input,
              output: rawOutput,
              observedFragments: [...candidatePool.values()].map((entry) => structuredClone(entry)),
            });
            const output = pruned?.output ?? rawOutput;
            let allObserved = Boolean(pruned?.allObserved);
            const presented = tool.present({ input, output });
            const rendered = normalizedHandoff(await tool.render(presented), presentation.truncationSuffix);
            const observed = [];
            const resultCandidates = [];
            let observationsFiltered = false;
            if (tool.handoff && rendered) {
              const candidates = await tool.handoffItems({ input, output, presented, rendered });
              const rawCandidates = [];
              for (const candidate of Array.isArray(candidates) ? candidates : []) {
                const fragment = {
                  toolName: String(candidate?.toolName || call.name),
                  rendered: String(candidate?.rendered || "").trim(),
                  presented: candidate?.presented && typeof candidate.presented === "object" ? candidate.presented : {},
                  ...(candidate?.knowledge ? { knowledge: candidate.knowledge } : {}),
                  ...(candidate?.reference?.kind && candidate?.reference?.name ? {
                    reference: { kind: String(candidate.reference.kind), name: String(candidate.reference.name) },
                  } : {}),
                  priority: Number(candidate?.priority || 0),
                };
                if (!fragment.rendered) continue;
                rawCandidates.push(fragment);
              }
              const visibleCandidates = await filterObservations(rawCandidates);
              observationsFiltered = visibleCandidates.length !== rawCandidates.length;
              if (rawCandidates.length && visibleCandidates.length === 0) allObserved = true;
              for (const fragment of visibleCandidates) {
                const candidateId = webAgentCandidateId(fragment);
                const existed = candidatePool.has(candidateId);
                const stored = addCandidate(candidatePool, fragment);
                if (stored) {
                  const storedKnowledgeKey = String(stored?.knowledge?.key || "");
                  if (storedKnowledgeKey) {
                    for (let index = resultCandidates.length - 1; index >= 0; index -= 1) {
                      if (String(resultCandidates[index]?.knowledge?.key || "") === storedKnowledgeKey) resultCandidates.splice(index, 1);
                    }
                  }
                  resultCandidates.push(stored);
                }
                if (stored && !existed) observed.push(stored);
              }
            }
            if (observed.length && typeof observationSink === "function") {
              await observationSink(observed.map((entry) => structuredClone(entry)));
            }
            const content = allObserved
              ? await this.prompts.webToolResult("alreadyObserved")
              : mode === "work"
                ? await workToolResult(resultCandidates, rendered, this.prompts, presentation)
                : rendered || await this.prompts.webToolResult("emptyResult");
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
            const modelMessages = allObserved ? [] : await tool.modelMessages({ input, output, presented });
            supplementalModelMessages.push(...(Array.isArray(modelMessages) ? modelMessages : []));
            if (tool.timelineRead && rendered && !allObserved) {
              const timelineOutput = mode === "work" && observationsFiltered && resultCandidates.length
                ? mergedPresentation(resultCandidates)
                : presented;
              await emit("run.context.read", { callId: call.id, name: call.name, input, output: timelineOutput });
            }
            toolCache.set(cacheKey, { content, rendered, presented });
          } catch (error) {
            const fallbackMessage = await this.prompts.webToolResult("toolFailure");
            const toolError = {
              code: String(error?.code || "TOOL_FAILED"),
              message: String(redactSensitive(String(error?.message || fallbackMessage))).slice(0, 16_384),
              retryable: Boolean(error?.retryable),
            };
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: await this.prompts.webToolResult("failedResult", { ERROR_MESSAGE: toolError.message }),
            });
          }
        }
        messages.push(...supplementalModelMessages);
        if (mode === "work" && submittedCandidateIds !== null) return completeWork(iteration + 1, submittedCandidateIds);
        if (mode === "work" && terminalArgumentsFailed && forcedSubmitAttempt && !hasNonTerminalCalls) {
          // The provider failed both the ordinary required-tool request and a
          // named handoff_submit retry. Keep only required fragments and let
          // the original user request proceed instead of failing the turn.
          return completeWork(iteration + 1, []);
        }
        if (mode === "work" && !hasNonTerminalCalls) forceSubmit = true;
      }
      if (mode === "work") return completeWork(this.limits.maxIterations, []);
      throw new Error("Web Agent exceeded iteration budget");
    } catch (error) {
      if (runSignal.aborted) {
        await emit("run.aborted", { reason: String(redactSensitive(String(runSignal.reason?.message || runSignal.reason || "aborted"))).slice(0, 16_384) });
      } else {
        await emit("run.failed", {
          code: String(error?.code || "WEB_AGENT_FAILED").replace(/[^A-Za-z0-9._:-]/g, "_"),
          message: String(redactSensitive(String(error?.message || error || "网页 Agent 执行失败"))).slice(0, 16_384),
        });
      }
      if (error && typeof error === "object") {
        try { error.easyworkRunTerminalEmitted = true; } catch { /* non-extensible errors keep the fallback event */ }
      }
      throw error;
    }
  }

}

export { DEFAULT_LIMITS as WEB_AGENT_LIMITS };
