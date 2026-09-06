import crypto from "node:crypto";

import { invariant } from "../errors.mjs";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 48 * 1024;
const MAX_SESSIONS = 32;
const MAX_SCROLLBACK_BYTES = 1024 * 1024;

function exactObject(value, keys, field) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  invariant(Object.keys(input).every((key) => keys.includes(key)), "TERMINAL_INPUT_SCHEMA_INVALID", `${field} 包含未知字段`, { status: 400, details: { allowed: keys } });
  return input;
}

function dimension(value, fallback, field) {
  const result = Number(value ?? fallback);
  invariant(Number.isSafeInteger(result) && result > 0 && result <= 10_000, "TERMINAL_DIMENSION_INVALID", `${field} 无效`, { status: 400 });
  return result;
}

function workingDirectory(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value);
  invariant(result.startsWith("/") && result.length <= 4_096 && !/[\0\r\n]/.test(result), "TERMINAL_CWD_INVALID", "终端工作目录无效", { status: 400 });
  return result;
}

function terminalScopeKey(value) {
  const result = String(value || "").trim();
  invariant(result.length > 0 && result.length <= 1_024 && !/[\0\r\n]/.test(result), "TERMINAL_SCOPE_INVALID", "终端会话范围无效", { status: 400 });
  return result;
}

function decodeInput(input) {
  invariant(!(input.text !== undefined && input.dataBase64 !== undefined), "TERMINAL_INPUT_AMBIGUOUS", "终端输入只能使用 text 或 dataBase64 之一", { status: 400 });
  let bytes;
  if (input.dataBase64 !== undefined) {
    invariant(typeof input.dataBase64 === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64), "TERMINAL_INPUT_BASE64_INVALID", "终端输入不是有效 Base64", { status: 400 });
    bytes = Buffer.from(input.dataBase64, "base64");
  } else {
    invariant(typeof input.text === "string", "TERMINAL_INPUT_REQUIRED", "终端输入不能为空", { status: 400 });
    bytes = Buffer.from(input.text, "utf8");
  }
  invariant(bytes.length > 0 && bytes.length <= MAX_INPUT_BYTES, "TERMINAL_INPUT_SIZE_INVALID", "终端单次输入大小无效", {
    status: bytes.length > MAX_INPUT_BYTES ? 413 : 400,
    details: { maxBytes: MAX_INPUT_BYTES },
  });
  return bytes;
}

export class SshTerminalManager {
  constructor({ worker, serverId, serverIdentity, broker, clock = () => new Date() }) {
    invariant(worker?.withSession && serverId && serverIdentity && broker?.append, "TERMINAL_DEPENDENCY_INVALID", "终端依赖无效", { status: 500, expose: false });
    this.worker = worker;
    this.serverId = String(serverId);
    this.serverIdentity = String(serverIdentity);
    this.broker = broker;
    this.clock = clock;
    this.sessions = new Map();
    this.pendingCreates = 0;
    this.closeGeneration = 0;
  }

  async create(input = {}) {
    const value = exactObject(input, ["term", "rows", "cols", "cwd", "scopeKey", "commandId"], "创建终端");
    const openCount = [...this.sessions.values()].filter((state) => state.status === "open").length;
    invariant(openCount + this.pendingCreates < MAX_SESSIONS, "TERMINAL_SESSION_LIMIT", "当前服务器终端会话数已达上限", { status: 429, details: { limit: MAX_SESSIONS } });
    const cwd = workingDirectory(value.cwd);
    const scopeKey = terminalScopeKey(value.scopeKey);
    const descriptor = {
      term: String(value.term || "xterm-256color"),
      rows: dimension(value.rows, 24, "rows"),
      cols: dimension(value.cols, 80, "cols"),
      ...(cwd ? { cwd } : {}),
    };
    const generation = this.closeGeneration;
    this.pendingCreates += 1;
    let handle;
    try {
      handle = await this.worker.withSession(this.serverId, async (session) => {
        invariant(typeof session.openPty === "function", "REMOTE_TERMINAL_UNAVAILABLE", "SSH transport 不支持受控 PTY", { status: 409 });
        return session.openPty(descriptor);
      });
      if (generation !== this.closeGeneration) {
        await handle.close();
        invariant(false, "TERMINAL_SESSION_CLOSED", "终端创建已取消", { status: 409 });
      }
    } finally {
      this.pendingCreates -= 1;
    }
    const sessionId = `term_${crypto.randomBytes(16).toString("hex")}`;
    const topic = `terminal:${sessionId}`;
    const now = new Date(this.clock()).toISOString();
    const state = {
      sessionId,
      topic,
      handle,
      attached: true,
      status: "open",
      scopeKey,
      descriptor,
      openedAt: now,
      updatedAt: now,
      publishChain: Promise.resolve(),
      closeResult: null,
      outputBuffer: Buffer.alloc(0),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputTimer: null,
    };
    this.sessions.set(sessionId, state);
    handle.onData(({ stream, bytes }) => this.#publishOutput(state, stream, bytes));
    handle.onClose((error, result) => this.#remoteClosed(state, error, result));
    await this.#publish(state, "terminal.opened", "started", {
      sessionId,
      serverId: this.serverId,
      serverIdentity: this.serverIdentity,
      ...descriptor,
    });
    return this.#summary(state);
  }

  async input(sessionId, input = {}) {
    const state = this.#requireOpen(sessionId);
    const value = exactObject(input, ["text", "dataBase64", "commandId"], "终端输入");
    const bytes = decodeInput(value);
    const acceptedBytes = state.handle.write(bytes);
    state.updatedAt = new Date(this.clock()).toISOString();
    await this.worker.touch?.(this.serverId);
    return { sessionId: state.sessionId, acceptedBytes };
  }

  async resize(sessionId, input = {}) {
    const state = this.#requireOpen(sessionId);
    const value = exactObject(input, ["rows", "cols", "commandId"], "调整终端大小");
    const descriptor = state.handle.resize({
      rows: dimension(value.rows, state.descriptor.rows, "rows"),
      cols: dimension(value.cols, state.descriptor.cols, "cols"),
    });
    state.descriptor = { ...state.descriptor, ...descriptor };
    state.updatedAt = new Date(this.clock()).toISOString();
    return this.#summary(state);
  }

  async detach(sessionId) {
    const state = this.#requireOpen(sessionId);
    state.updatedAt = new Date(this.clock()).toISOString();
    // A browser view disappearing must never detach the shared PTY for the
    // same account on another device.  The socket stays attached to EasyWork;
    // browser clients only unsubscribe from its realtime topic.
    return this.#summary(state);
  }

  async resume(sessionId) {
    const state = this.#requireOpen(sessionId);
    state.updatedAt = new Date(this.clock()).toISOString();
    await this.worker.touch?.(this.serverId);
    return this.#summary(state);
  }

  inspect(sessionId) {
    const state = this.#require(sessionId);
    return this.#summary(state, { includeOutput: true });
  }

  list(input = {}) {
    const value = exactObject(input, ["scopeKey"], "读取终端");
    const scopeKey = terminalScopeKey(value.scopeKey);
    return [...this.sessions.values()]
      .filter((state) => state.scopeKey === scopeKey && state.status === "open")
      .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
      .map((state) => this.#summary(state, { includeOutput: true }));
  }

  owns(sessionId) {
    return this.sessions.has(String(sessionId));
  }

  ownsTopic(topic) {
    const sessionId = /^terminal:(term_[a-f0-9]{32})$/.exec(String(topic || ""))?.[1];
    return Boolean(sessionId && this.owns(sessionId));
  }

  async close(sessionId) {
    const state = this.#require(sessionId);
    if (state.status === "open") await state.handle.close();
    if (state.status === "open") await this.#remoteClosed(state, null, { code: null, signal: null });
    await state.publishChain;
    return this.#summary(state);
  }

  async closeAll() {
    this.closeGeneration += 1;
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.close(sessionId)));
  }

  hasOpenSessions() {
    return [...this.sessions.values()].some((state) => state.status === "open" && !state.handle.closed);
  }

  #require(sessionId) {
    const id = String(sessionId || "");
    invariant(/^term_[a-f0-9]{32}$/.test(id), "TERMINAL_SESSION_ID_INVALID", "终端 sessionId 无效", { status: 400 });
    const state = this.sessions.get(id);
    invariant(state, "TERMINAL_SESSION_NOT_FOUND", "终端会话不存在", { status: 404 });
    return state;
  }

  #requireOpen(sessionId) {
    const state = this.#require(sessionId);
    invariant(state.status === "open" && !state.handle.closed, "TERMINAL_SESSION_CLOSED", "终端会话已关闭", { status: 409 });
    return state;
  }

  #summary(state, { includeOutput = false } = {}) {
    return {
      sessionId: state.sessionId,
      topic: state.topic,
      status: state.status,
      attached: state.attached,
      scopeKey: state.scopeKey,
      term: state.descriptor.term,
      rows: state.descriptor.rows,
      cols: state.descriptor.cols,
      cwd: state.descriptor.cwd || null,
      openedAt: state.openedAt,
      updatedAt: state.updatedAt,
      closeResult: state.closeResult,
      ...(includeOutput ? { outputBase64: state.outputBuffer.toString("base64") } : {}),
    };
  }

  #publishOutput(state, stream, bytes) {
    if (state.status !== "open") return;
    const value = Buffer.from(bytes);
    state.outputBuffer = Buffer.concat([state.outputBuffer, value]);
    if (state.outputBuffer.length > MAX_SCROLLBACK_BYTES) state.outputBuffer = state.outputBuffer.subarray(state.outputBuffer.length - MAX_SCROLLBACK_BYTES);
    const source = stream === "stderr" ? "stderr" : "stdout";
    // Interactive shells may echo one byte per SSH frame. Persist bounded
    // bursts instead of one full journal rewrite per character; otherwise
    // closing the terminal can wait minutes for thousands of queued writes.
    for (let offset = 0; offset < value.length;) {
      let pending = state.pendingOutput.at(-1);
      if (!pending || pending.stream !== source || pending.size === MAX_EVENT_BYTES) {
        pending = { stream: source, chunks: [], size: 0 };
        state.pendingOutput.push(pending);
      }
      const chunk = value.subarray(offset, offset + Math.min(MAX_EVENT_BYTES - pending.size, value.length - offset));
      pending.chunks.push(chunk);
      pending.size += chunk.length;
      state.pendingOutputBytes += chunk.length;
      offset += chunk.length;
      if (state.pendingOutputBytes >= MAX_EVENT_BYTES) this.#flushOutput(state);
    }
    if (state.pendingOutput.length && !state.outputTimer) {
      state.outputTimer = setTimeout(() => this.#flushOutput(state), 16);
      state.outputTimer.unref?.();
    }
  }

  #flushOutput(state) {
    clearTimeout(state.outputTimer);
    state.outputTimer = null;
    const pending = state.pendingOutput;
    state.pendingOutput = [];
    state.pendingOutputBytes = 0;
    for (const batch of pending) {
      const chunk = Buffer.concat(batch.chunks, batch.size);
      this.#publish(state, "terminal.output", "updated", {
        sessionId: state.sessionId,
        stream: batch.stream,
        dataBase64: chunk.toString("base64"),
        byteLength: chunk.length,
      });
    }
  }

  async #remoteClosed(state, error, result) {
    if (state.status === "closed") return;
    this.#flushOutput(state);
    state.status = "closed";
    state.attached = false;
    state.updatedAt = new Date(this.clock()).toISOString();
    state.closeResult = {
      code: Number.isInteger(result?.code) ? result.code : null,
      signal: result?.signal || null,
      error: error ? { code: String(error.code || "SSH_PTY_FAILED"), message: String(error.message || "PTY 已异常关闭").slice(0, 2_000) } : null,
    };
    await this.#publish(state, "terminal.closed", error ? "failed" : "completed", { sessionId: state.sessionId, ...state.closeResult });
    const closed = [...this.sessions.values()].filter((entry) => entry.status === "closed");
    for (const entry of closed.slice(0, Math.max(0, closed.length - MAX_SESSIONS))) this.sessions.delete(entry.sessionId);
  }

  #publish(state, kind, status, payload) {
    state.publishChain = state.publishChain.then(() => this.broker.append(state.topic, {
      producer: "remote-terminal",
      kind,
      status,
      ids: { serverId: this.serverId, terminalSessionId: state.sessionId },
      payload,
    })).catch(() => undefined);
    return state.publishChain;
  }
}

export const terminalLimits = Object.freeze({ maxInputBytes: MAX_INPUT_BYTES, maxEventBytes: MAX_EVENT_BYTES, maxSessions: MAX_SESSIONS, maxScrollbackBytes: MAX_SCROLLBACK_BYTES });
