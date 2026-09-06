import crypto from "node:crypto";
import path from "node:path";

import { AtomicJsonRepository } from "../repository.mjs";
import { assertServerIdentity } from "../entities/common.mjs";
import { assertJobId, assertSshUsername } from "./contract.mjs";

const inlineQueue = Object.freeze({ run: async (_actor, operation) => operation() });
const TERMINAL = new Set(["completed", "failed", "cancelled", "timeout"]);
const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "commandexecution"]);

// This lexer recognizes direct shell submissions, not text inside echo/cat,
// source files or search results. Unknown shell syntax is deliberately not
// interpreted as proof that a submission happened.
function statements(command) {
  const result = [];
  const hereDocuments = [];
  let words = [], word = "", quote = "", escaped = false;
  const endWord = () => { if (word) words.push(word); word = ""; };
  const endStatement = () => { endWord(); if (words.length) result.push(words); words = []; };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) { if (char !== "\n") word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && !word) {
      while (index < command.length && command[index] !== "\n") index += 1;
      index -= 1;
      continue;
    }
    if (char === "<" && command[index + 1] === "<") {
      // A script written with cat <<EOF is data, while sbatch after its
      // delimiter (or sbatch reading the here-document itself) is executable.
      // Keep those separate instead of dropping the entire shell invocation.
      if (command[index + 2] === "<") return [];
      endWord();
      let cursor = index + 2;
      const stripTabs = command[cursor] === "-";
      if (stripTabs) cursor += 1;
      while (/[ \t]/.test(command[cursor] || "\n")) cursor += 1;
      let delimiter = "", delimiterQuote = "";
      for (; cursor < command.length; cursor += 1) {
        const next = command[cursor];
        if (next === "\\" && delimiterQuote !== "'") {
          if (cursor + 1 >= command.length || command[cursor + 1] === "\n") return [];
          delimiter += command[++cursor];
        } else if (delimiterQuote) {
          if (next === delimiterQuote) delimiterQuote = "";
          else delimiter += next;
        } else if (next === "'" || next === '"') delimiterQuote = next;
        else if (/\s/.test(next) || ";|&()<>".includes(next)) break;
        else delimiter += next;
      }
      if (!delimiter || delimiterQuote) return [];
      hereDocuments.push({ delimiter, stripTabs });
      index = cursor - 1;
      continue;
    }
    if (";|&\n()".includes(char)) endStatement();
    else if (/\s/.test(char)) endWord();
    else word += char;
    if (char === "\n" && hereDocuments.length) {
      let cursor = index + 1;
      for (const document of hereDocuments) {
        let closed = false;
        while (cursor < command.length) {
          const newline = command.indexOf("\n", cursor);
          const lineEnd = newline < 0 ? command.length : newline;
          let line = command.slice(cursor, lineEnd).replace(/\r$/, "");
          if (document.stripTabs) line = line.replace(/^\t+/, "");
          cursor = lineEnd + 1;
          if (line === document.delimiter) { closed = true; break; }
        }
        if (!closed) return [];
      }
      hereDocuments.length = 0;
      index = cursor - 1;
    }
  }
  if (quote || escaped || hereDocuments.length) return [];
  endStatement();
  return result;
}

function submissionCommands(command, depth = 0, executableName = "sbatch") {
  if (depth > 3 || typeof command !== "string" || command.length > 262_144) return [];
  return statements(command).flatMap((tokens) => {
    let index = 0;
    while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || ["env", "command", "exec", "then", "do"].includes(tokens[index]))) index += 1;
    const executable = path.posix.basename(tokens[index] || "");
    const args = tokens.slice(index + 1);
    if (["bash", "sh", "zsh"].includes(executable)) {
      const script = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      return script >= 0 ? submissionCommands(args[script + 1], depth + 1, executableName) : [];
    }
    if (executable !== executableName || args.some((arg) => ["--test-only", "--help", "--usage", "--version", "-V"].includes(arg))) return [];
    return [args];
  });
}

function option(args, short, long) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === short || arg === long) return args[index + 1] || "";
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
    if (arg.startsWith(short) && arg.length > short.length) return arg.slice(short.length);
  }
  return "";
}

export function slurmSubmissionReceipts(command, output) {
  const invocations = submissionCommands(command);
  if (!invocations.length) return [];
  const parsable = invocations.some((args) => args.includes("--parsable"));
  const ids = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^Submitted batch job (\d+(?:_\d+)?)$/)
      || (parsable ? line.trim().match(/^(\d+(?:_\d+)?)(?:;[A-Za-z0-9_.-]+)?$/) : null);
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)].map((jobId, index) => {
    const args = invocations.length === ids.length ? invocations[index] : invocations.length === 1 ? invocations[0] : [];
    return {
      jobId,
      name: option(args, "-J", "--job-name").slice(0, 255) || "EasyWork 提交作业",
      partition: option(args, "-p", "--partition").slice(0, 255) || "未记录",
    };
  });
}

function agentShellInvocation({ event, binding }) {
  if (event?.kind !== "tool_result" || !["updated", "completed", "failed"].includes(event.phase)) return null;
  const payload = event.payload || {};
  if (!SHELL_TOOLS.has(String(payload.name || "").toLowerCase().split(".").at(-1))) return null;
  const known = binding?.state?.items?.[payload.callId] || {};
  let input = payload.input || known.input || {};
  if (!input.command && !input.cmd && !known.command) {
    // Claude partial-message input is associated with its content-block id;
    // tool_use_id is the stable link to the execution's terminal result.
    const block = Object.values(binding?.state?.items || {}).find((item) => item.toolId === payload.callId && item.partialJson);
    try { if (block) input = JSON.parse(block.partialJson); } catch { return null; }
  }
  const command = input.command || input.cmd || known.command;
  let output = payload.text || payload.output || known.output || known.aggregatedOutput || "";
  if (event.phase === "updated") {
    // Only a complete streamed line proves the complete JobID. Reconstruct a
    // line split across deltas from the adapter's cumulative item, but do not
    // rescan receipts on every later progress chunk from the same shell call.
    const cumulative = String(known.output || known.aggregatedOutput || output);
    const delta = String(payload.text || "");
    const start = payload.delta === true && cumulative.endsWith(delta)
      ? cumulative.slice(0, cumulative.length - delta.length).lastIndexOf("\n") + 1 : 0;
    output = cumulative.slice(start, cumulative.lastIndexOf("\n") + 1);
  }
  return { command, output, callId: String(payload.callId) };
}

export function agentSchedulerActivity(input) {
  if (!["completed", "failed"].includes(input.event?.phase)) return false;
  const invocation = agentShellInvocation(input);
  return Boolean(invocation && ["sbatch", "srun", "scancel", "squeue", "sacct", "scontrol"].some((name) => submissionCommands(invocation.command, 0, name).length));
}

export function agentSubmissionReceipts(input) {
  const invocation = agentShellInvocation(input);
  if (!invocation) return [];
  return slurmSubmissionReceipts(invocation.command, invocation.output).map((receipt) => ({
    ...receipt,
    callId: invocation.callId,
  }));
}

export class SchedulerSubmissionLedger {
  constructor({ actor, dataRoot, serverIdentity, username, clock = () => new Date() }) {
    this.serverIdentity = assertServerIdentity(serverIdentity);
    this.username = assertSshUsername(username);
    this.clock = clock;
    this.repository = new AtomicJsonRepository({
      actor,
      dataRoot,
      relativePath: ["scheduler", this.serverIdentity, this.username, "submissions.json"],
      schemaVersion: 1,
      defaultData: () => ({ serverIdentity: this.serverIdentity, username: this.username, submissions: [] }),
      validate: (data) => data?.serverIdentity === this.serverIdentity && data?.username === this.username
        && Array.isArray(data.submissions) && data.submissions.every((item) => /^[a-f0-9]{64}$/.test(item.id)
          && /^\d+(?:_\d+)?$/.test(item.jobId) && Number.isFinite(Date.parse(item.submittedAt))),
      queue: inlineQueue,
    });
  }

  async #update(mutator) {
    for (;;) {
      const current = await this.repository.read();
      const next = structuredClone(current.data);
      const result = mutator(next);
      if (JSON.stringify(current.data) === JSON.stringify(next)) return result;
      try { await this.repository.replace(next, { expectedRevision: current.revision, clock: this.clock }); return result; }
      catch (error) { if (error?.code !== "REVISION_CONFLICT") throw error; }
    }
  }

  async record(receipts, { taskId = null, conversationId = null, workspaceId = null, agentId = null, commandId = null } = {}) {
    const submittedAt = new Date(this.clock()).toISOString();
    return this.#update((data) => {
      const created = [];
      for (const receipt of receipts) {
        const jobId = assertJobId(receipt.jobId);
        const id = crypto.createHash("sha256").update(JSON.stringify([taskId, receipt.callId || commandId, jobId])).digest("hex");
        if (data.submissions.some((item) => item.id === id)) continue;
        data.submissions.push({ id, jobId, submittedAt, taskId, conversationId, workspaceId, agentId,
          callId: receipt.callId || null, commandId, name: receipt.name || "EasyWork 提交作业", partition: receipt.partition || "未记录", snapshot: null });
        created.push(jobId);
      }
      return created;
    });
  }

  async updateJobs(jobs) {
    if (!jobs.length) return;
    const byId = new Map(jobs.filter((job) => job.owner === this.username).map((job) => [job.id, job]));
    await this.#update((data) => {
      for (const receipt of data.submissions) {
        const job = byId.get(receipt.jobId);
        if (!job || (TERMINAL.has(receipt.snapshot?.state) && !TERMINAL.has(job.state))) continue;
        receipt.snapshot = structuredClone(job);
      }
    });
  }

  async pending() {
    const data = (await this.repository.read()).data;
    return [...new Map(data.submissions
      .filter((item) => !TERMINAL.has(item.snapshot?.state))
      .map((item) => [item.jobId, { jobId: item.jobId }])).values()];
  }

  async list({ startDate, endDate, utcOffsetMinutes = 0 }) {
    const offset = utcOffsetMinutes * 60_000;
    const start = Date.parse(`${startDate}T00:00:00Z`) - offset;
    const end = Date.parse(`${endDate}T00:00:00Z`) + 86_400_000 - offset;
    const data = (await this.repository.read()).data;
    return data.submissions.filter((item) => Date.parse(item.submittedAt) >= start && Date.parse(item.submittedAt) < end).map((item) => ({
      id: item.jobId, scheduler: "slurm", owner: this.username, name: item.name, partition: item.partition,
      state: "unknown", elapsed: "", timeLeft: "", nodes: 0, cpuCores: 0, startedAt: null, endedAt: null,
      locationOrReason: "EasyWork 已记录提交；调度器尚未返回终态",
      ...(item.snapshot || {}), submittedAt: item.submittedAt, historySource: "easywork-submission",
    }));
  }
}

// Track only accepted EasyWork submissions. This is independent of native
// Agent queries and of whether a browser has the job panel open: some sites
// retain controller records for only a few minutes and have no accounting.
export class SchedulerSubmissionTracker {
  constructor({ ledger, inspectJob, canPoll = async () => true, intervalMs = 15_000,
    setTimer = setTimeout, clearTimer = clearTimeout, onChanged = async () => {} }) {
    this.ledger = ledger;
    this.inspectJob = inspectJob;
    this.canPoll = canPoll;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onChanged = onChanged;
    this.observed = new Map();
    this.refreshPending = false;
    this.jobs = new Map();
    this.timer = null;
    this.inFlight = null;
    this.closed = false;
    this.sequence = 0;
  }

  async resume(jobIds = null) {
    if (this.closed) return;
    const selected = jobIds ? new Set(jobIds.map(String)) : null;
    const pending = await this.ledger.pending();
    if (this.closed) return;
    for (const { jobId } of pending) {
      if ((!selected || selected.has(jobId)) && !this.jobs.has(jobId)) {
        this.jobs.set(jobId, { misses: 0, checked: 0 });
      }
    }
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (this.inFlight) this.refreshPending = true;
    else this.#schedule(0);
  }

  #schedule(delay) {
    if (this.closed || this.timer !== null || this.inFlight || !this.jobs.size) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.poll().catch((error) => console.error(JSON.stringify({
        scope: "scheduler-submission-track", code: error?.code || "SCHEDULER_TRACKING_FAILED",
      })));
    }, delay);
    this.timer?.unref?.();
  }

  async poll() {
    if (this.inFlight) return this.inFlight;
    if (this.closed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const operation = this.#poll();
    this.inFlight = operation;
    try { return await operation; }
    finally {
      this.inFlight = null;
      const immediate = this.refreshPending;
      this.refreshPending = false;
      this.#schedule(immediate ? 0 : this.intervalMs);
    }
  }

  async #poll() {
    let connected = false;
    try { connected = await this.canPoll(); } catch { /* The server may have been removed or access revoked. */ }
    if (!connected) {
      // A deliberate disconnect is not permission to reconnect in the
      // background. Durable unresolved receipts are reconsidered on connect.
      this.jobs.clear();
      return;
    }
    const batch = [...this.jobs].sort((a, b) => a[1].checked - b[1].checked).slice(0, 20);
    const snapshots = [];
    const inspect = async ([jobId, state]) => {
      if (this.closed) return;
      state.checked = ++this.sequence;
      let job = null;
      try { job = await this.inspectJob(jobId); } catch { return; /* A transient SSH failure does not retire a receipt. */ }
      if (job?.id === jobId && job.owner === this.ledger.username) {
        state.misses = 0;
        snapshots.push(job);
      } else if (++state.misses >= 3) {
        // Retired/unknown jobs must not create an endless polling loop.
        // Neither a missing record nor an error proves success or failure.
        this.jobs.delete(jobId);
      }
    };
    for (let offset = 0; offset < batch.length; offset += 4) {
      await Promise.all(batch.slice(offset, offset + 4).map(inspect));
    }
    await this.ledger.updateJobs(snapshots);
    const changed = snapshots.filter((job) => {
      const signature = JSON.stringify([job.state, job.startedAt, job.endedAt, job.locationOrReason]);
      if (this.observed.get(job.id) === signature) return false;
      this.observed.set(job.id, signature);
      return true;
    }).map((job) => job.id);
    if (changed.length) await this.onChanged(changed);
    for (const job of snapshots) if (TERMINAL.has(job.state)) this.jobs.delete(job.id);
  }

  async close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.jobs.clear();
    await this.inFlight?.catch(() => undefined);
  }
}
