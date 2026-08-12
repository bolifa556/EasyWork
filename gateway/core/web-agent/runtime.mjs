import { randomUUID } from "node:crypto";

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
        }))
      : [],
    usage: value.usage && typeof value.usage === "object" ? value.usage : null,
  };
}

const MAX_HANDOFF_ITEM_CHARACTERS = 12_000;
const MAX_HANDOFF_CHARACTERS = 48_000;

function handoffContext(records) {
  if (!records.length) return "";
  const sections = ["上下文证据（由 EasyWork 按当前授权范围读取）："];
  let remaining = MAX_HANDOFF_CHARACTERS - sections[0].length;
  for (const record of records) {
    if (remaining <= 0) break;
    let serialized;
    try {
      serialized = JSON.stringify(record.context, null, 2);
    } catch {
      serialized = JSON.stringify({ source: record.name, error: "context serialization failed" });
    }
    if (serialized.length > MAX_HANDOFF_ITEM_CHARACTERS) serialized = `${serialized.slice(0, MAX_HANDOFF_ITEM_CHARACTERS)}\n…`;
    const section = `\n\n### ${record.name}\n${serialized}`;
    const accepted = section.slice(0, remaining);
    sections.push(accepted);
    remaining -= accepted.length;
  }
  return sections.join("");
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

  async run({ mode, actor, scope, userMessage, context = [], signal, runId = `web_${randomUUID()}` }) {
    if (!['chat', 'work'].includes(mode)) throw new TypeError("Unknown Web Agent mode");
    const runTimeout = AbortSignal.timeout(this.limits.maxWallTimeMs);
    const runSignal = combineSignals(signal, runTimeout);
    const system = await this.prompts.system(mode);
    const messages = [
      { role: "system", content: system },
      ...context,
      { role: "user", content: String(userMessage || "") },
    ];
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
    await emit("run.started", { mode });
    let toolCallCount = 0;
    let finalContent = "";
    let reasoning = "";
    let usage = null;
    const workContextRecords = [];
    try {
      for (let iteration = 0; iteration < this.limits.maxIterations; iteration += 1) {
        runSignal.throwIfAborted();
        let streamedContent = "";
        let streamedReasoning = "";
        let streamedOutput = false;
        const segmentId = `${runId}:output:${iteration}`;
        const rawResult = await this.model.complete({
          mode,
          messages,
          tools: this.tools.definitions(mode),
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
            finalContent = handoffContext(workContextRecords);
            await emit("run.handoff.ready", {
              userMessage: String(userMessage || ""),
              contextBrief: finalContent,
            });
            await emit("run.context.completed", { usage });
          } else {
            if (nextContent) finalContent += nextContent;
            if (nextContent) await emit("run.output.committed", { iteration, segmentId, target: "final" });
            await emit("run.completed", { usage });
          }
          return { runId, content: finalContent, reasoning, usage, iterations: iteration + 1, toolCallCount };
        }
        if (nextContent) await emit("run.output.committed", { iteration, segmentId, target: "activity" });
        messages.push({
          role: "assistant",
          content: nextContent,
          toolCalls: result.toolCalls,
        });
        for (const call of result.toolCalls) {
          runSignal.throwIfAborted();
          toolCallCount += 1;
          if (toolCallCount > this.limits.maxToolCalls) throw new Error("Web Agent exceeded tool-call budget");
          const tool = this.tools.resolve(call.name, mode);
          if (!tool) throw new Error(`Web Agent requested unavailable tool: ${call.name}`);
          const input = tool.validate(call.input);
          const idempotencyKey = `${runId}:${call.id}`;
          await emit("run.tool.started", { callId: call.id, name: call.name, input, mutating: tool.mutating });
          const toolSignal = combineSignals(runSignal, AbortSignal.timeout(this.limits.toolTimeoutMs));
          try {
            const output = await tool.execute({ actor, scope, input, idempotencyKey, signal: toolSignal });
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(output ?? null) });
            if (mode === "work" && tool.handoff) {
              workContextRecords.push({ name: call.name, context: tool.handoff({ input, output }) });
            }
            await emit("run.tool.completed", { callId: call.id, name: call.name, output });
          } catch (error) {
            const toolError = {
              code: String(error?.code || "TOOL_FAILED"),
              message: String(error?.message || "工具调用失败"),
              retryable: Boolean(error?.retryable),
            };
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ error: toolError }) });
            await emit("run.tool.failed", { callId: call.id, name: call.name, error: toolError });
          }
        }
      }
      throw new Error("Web Agent exceeded iteration budget");
    } catch (error) {
      if (runSignal.aborted) {
        await emit("run.aborted", { reason: String(runSignal.reason?.message || runSignal.reason || "aborted") });
      } else {
        await emit("run.failed", { code: String(error?.code || "WEB_AGENT_FAILED"), message: String(error?.message || error) });
      }
      throw error;
    }
  }

}

export { DEFAULT_LIMITS as WEB_AGENT_LIMITS };
