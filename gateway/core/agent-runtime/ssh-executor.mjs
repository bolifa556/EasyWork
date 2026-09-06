import crypto from "node:crypto";
import path from "node:path";

import { ApiError, invariant } from "../errors.mjs";

const HTTP_LIMIT = 16 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const JSON_RPC_TIMEOUT_MS = 60_000;
const CONTROL_REQUEST_TIMEOUT_MS = 3_000;
const SFTP_OPERATION_TIMEOUT_MS = 60_000;
const SFTP_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const AGENT_STREAM_QUEUE_MAX_ITEMS = 4_096;
const AGENT_STREAM_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const AGENT_STREAM_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function providerEnvironmentPrefix(envFile) {
  const value = String(envFile || "").trim();
  if (!value) return "";
  const quoted = shellQuote(value);
  return `[ -f ${quoted} ] || exit 78; . ${quoted}; `;
}

function commandLine({ executable, args = [], cwd, env = {}, envFile = null }) {
  const command = [shellQuote(executable), ...args.map(shellQuote)].join(" ");
  const exported = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const body = `${providerEnvironmentPrefix(envFile)}printf '__EASYWORK_REMOTE_PID__:%s\\n' "$$"; ${exported ? `${exported} ` : ""}exec ${command}`;
  return cwd ? `cd ${shellQuote(cwd)} && { ${body}; }` : `{ ${body}; }`;
}

function detachedCommandLine({ executable, args = [], cwd, env = {}, envFile = null, logPath }) {
  const command = [shellQuote(executable), ...args.map(shellQuote)].join(" ");
  const exported = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const output = shellQuote(logPath);
  // Shell assignments must precede `nohup`. Placing HOME=... after nohup
  // makes coreutils try to execute the assignment as a program, so the
  // detached service exits immediately and every later SSH forward is
  // refused even though the Agent and model are configured correctly.
  const body = `${providerEnvironmentPrefix(envFile)}${exported ? `${exported} ` : ""}nohup ${command} </dev/null >>${output} 2>&1 & pid=$!; kill -0 "$pid" 2>/dev/null || exit 74; printf '__EASYWORK_REMOTE_PID__:%s\\n' "$pid"`;
  return cwd ? `cd ${shellQuote(cwd)} && { ${body}; }` : `{ ${body}; }`;
}

class DetachedSshProcessHandle {
  constructor({ executor, processId, remotePid }) {
    this.executor = executor;
    this.processId = processId;
    this.remotePid = remotePid;
    this.closed = false;
    this.detached = true;
  }

  async signal(signal = "SIGTERM") {
    if (this.closed) return;
    const normalized = String(signal).replace(/^SIG/, "");
    invariant(/^[A-Z0-9]+$/.test(normalized), "AGENT_PROCESS_SIGNAL_INVALID", "Agent 进程信号无效", { status: 400 });
    await this.executor.exec(`kill -${normalized} -- ${this.remotePid} 2>/dev/null || true`);
    this.closed = true;
  }
}

class AsyncQueue {
  constructor(onReturn = null, {
    maxItems = AGENT_STREAM_QUEUE_MAX_ITEMS,
    maxBytes = AGENT_STREAM_QUEUE_MAX_BYTES,
    onOverflow = null,
    merge = null,
    replaceKey = null,
    discardPrevious = null,
  } = {}) {
    this.values = [];
    this.head = 0;
    this.queuedBytes = 0;
    this.queuedItems = 0;
    this.waiters = [];
    this.done = false;
    this.error = null;
    this.onReturn = onReturn;
    this.onOverflow = onOverflow;
    this.merge = merge;
    this.replaceKey = replaceKey;
    this.discardPrevious = discardPrevious;
    this.replacementIndexes = new Map();
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  push(value) {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      const removeQueued = (index) => {
        const queued = this.values[index];
        if (!queued || queued.removed) return;
        queued.removed = true;
        this.queuedItems -= 1;
        this.queuedBytes -= queued.bytes;
        if (queued.key && this.replacementIndexes.get(queued.key) === index) this.replacementIndexes.delete(queued.key);
      };
      const lastQueuedIndex = () => {
        for (let index = this.values.length - 1; index >= this.head; index -= 1) {
          if (!this.values[index].removed) return index;
        }
        return -1;
      };
      if (typeof this.discardPrevious === "function") {
        let candidateIndex = lastQueuedIndex();
        while (candidateIndex >= 0 && this.discardPrevious(this.values[candidateIndex].value, value) === true) {
          removeQueued(candidateIndex);
          candidateIndex = lastQueuedIndex();
        }
      }
      let queuedValue = value;
      let replaceIndex = -1;
      if (typeof this.merge === "function") {
        const candidateIndex = lastQueuedIndex();
        if (candidateIndex >= 0) {
          const merged = this.merge(this.values[candidateIndex].value, value);
          if (merged !== undefined) {
            queuedValue = merged;
            replaceIndex = candidateIndex;
          }
        }
      }
      let replacementKey = null;
      if (replaceIndex < 0 && typeof this.replaceKey === "function") {
        const selected = this.replaceKey(queuedValue);
        replacementKey = selected == null ? null : String(selected);
        const priorIndex = replacementKey ? this.replacementIndexes.get(replacementKey) : null;
        if (Number.isSafeInteger(priorIndex) && priorIndex >= this.head) removeQueued(priorIndex);
      }
      const bytes = typeof queuedValue === "string" || Buffer.isBuffer(queuedValue)
        ? Buffer.byteLength(queuedValue)
        : Buffer.byteLength(JSON.stringify(queuedValue) ?? String(queuedValue));
      const itemCount = this.queuedItems;
      const replacedBytes = replaceIndex >= 0 ? this.values[replaceIndex].bytes : 0;
      const nextItems = itemCount + (replaceIndex >= 0 ? 0 : 1);
      const nextBytes = this.queuedBytes - replacedBytes + bytes;
      if (nextItems > this.maxItems || nextBytes > this.maxBytes) {
        const error = new ApiError("AGENT_EVENT_BACKPRESSURE_OVERFLOW", "Agent 事件产生速度超过网关处理能力，已停止本轮以保护服务", {
          status: 502,
          retryable: true,
          expose: true,
          details: { queuedItems: itemCount, queuedBytes: this.queuedBytes, maxItems: this.maxItems, maxBytes: this.maxBytes },
        });
        this.values = [];
        this.head = 0;
        this.queuedBytes = 0;
        this.queuedItems = 0;
        this.replacementIndexes.clear();
        this.onOverflow?.(error);
        this.end(error);
        return;
      }
      if (replaceIndex >= 0) {
        const prior = this.values[replaceIndex];
        this.values[replaceIndex] = { value: queuedValue, bytes, key: prior.key || null, removed: false };
      } else {
        const index = this.values.length;
        this.values.push({ value: queuedValue, bytes, key: replacementKey, removed: false });
        this.queuedItems += 1;
        if (replacementKey) this.replacementIndexes.set(replacementKey, index);
      }
      this.queuedBytes = nextBytes;
    }
  }

  end(error = null) {
    if (this.done) return;
    this.done = true;
    this.error = error;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    while (this.head < this.values.length) {
      const queued = this.values[this.head];
      const consumedIndex = this.head;
      this.head += 1;
      if (queued.removed) continue;
      this.queuedItems -= 1;
      this.queuedBytes -= queued.bytes;
      if (queued.key && this.replacementIndexes.get(queued.key) === consumedIndex) this.replacementIndexes.delete(queued.key);
      if (this.head >= 1_024 && this.head * 2 >= this.values.length) {
        this.values = this.values.slice(this.head);
        this.head = 0;
        this.replacementIndexes.clear();
        for (const [index, entry] of this.values.entries()) {
          if (!entry.removed && entry.key) this.replacementIndexes.set(entry.key, index);
        }
      }
      return Promise.resolve({ value: queued.value, done: false });
    }
    if (this.done) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async return() {
    this.onReturn?.();
    this.end();
    return { value: undefined, done: true };
  }
}

class LineHub {
  constructor({ maxBacklog = 256, maxBacklogBytes = AGENT_STREAM_BACKLOG_MAX_BYTES } = {}) {
    this.maxBacklog = maxBacklog;
    this.maxBacklogBytes = maxBacklogBytes;
    this.backlog = [];
    this.backlogBytes = 0;
    this.subscribers = new Set();
    this.closed = false;
    this.failure = null;
  }

  publish(line) {
    if (this.closed) return;
    if (this.subscribers.size === 0) {
      this.backlog.push(line);
      this.backlogBytes += Buffer.byteLength(line);
      while (this.backlog.length > this.maxBacklog || this.backlogBytes > this.maxBacklogBytes) {
        this.backlogBytes -= Buffer.byteLength(this.backlog.shift());
      }
    }
    for (const subscriber of this.subscribers) subscriber.push(line);
  }

  subscribe(options = {}) {
    const queue = new AsyncQueue(
      () => this.subscribers.delete(queue),
      {
        ...options,
        onOverflow: (error) => {
          this.subscribers.delete(queue);
          options.onOverflow?.(error);
        },
      },
    );
    for (const line of this.backlog) queue.push(line);
    this.backlog = [];
    this.backlogBytes = 0;
    if (this.closed) queue.end(this.failure);
    else if (!queue.done) this.subscribers.add(queue);
    return queue;
  }

  close(error = null) {
    this.closed = true;
    this.failure = error;
    for (const subscriber of this.subscribers) subscriber.end(error);
    this.subscribers.clear();
  }
}

class SshProcessHandle {
  constructor({ channel, processId, onStderr, session }) {
    this.channel = channel;
    this.session = session;
    this.detached = false;
    this.processId = processId;
    this.remotePidObserved = false;
    this.hub = new LineHub();
    this.pendingRpc = new Map();
    this.pendingControls = new Map();
    this.rpcSequence = 0;
    this.buffer = "";
    this.closed = false;
    this.inputEnded = false;
    this.exit = new Promise((resolve, reject) => {
      this.resolveExit = resolve;
      this.rejectExit = reject;
    });
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    channel.on("data", (chunk) => this.#consume(chunk));
    channel.stderr?.on("data", (chunk) => onStderr?.(Buffer.from(chunk)));
    channel.once("error", (error) => this.#finish(error));
    channel.once("close", (code, signal) => this.#finish(null, { code: Number.isInteger(code) ? code : null, signal: signal || null }));
  }

  #consume(chunk) {
    this.buffer += Buffer.from(chunk).toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#publish(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  #publish(line) {
    const pid = String(line).match(/^__EASYWORK_REMOTE_PID__:(\d+)$/)?.[1];
    if (pid) {
      this.processId = `remote-${pid}`;
      this.remotePidObserved = true;
      this.resolveReady(this.processId);
      return;
    }
    try {
      const frame = JSON.parse(line);
      if (frame?.type === "control_response") {
        const requestId = String(frame.response?.request_id || frame.request_id || "");
        const pending = this.pendingControls.get(requestId);
        if (pending) {
          this.pendingControls.delete(requestId);
          clearTimeout(pending.timer);
          if (frame.response?.subtype === "error") {
            pending.reject(new ApiError("AGENT_CONTROL_FAILED", String(frame.response.error || "Agent 控制请求失败"), {
              status: 502,
              retryable: true,
            }));
          } else pending.resolve(frame);
          return;
        }
      }
      if (frame?.id != null && !frame?.method) {
        const requestId = String(frame.id);
        const pending = this.pendingRpc.get(requestId);
        if (pending) {
          this.pendingRpc.delete(requestId);
          clearTimeout(pending.timer);
          if (frame.error) pending.reject(new ApiError("AGENT_RPC_FAILED", String(frame.error.message || "Agent RPC 失败"), {
            status: 502,
            details: { code: frame.error.code ?? null },
          }));
          else pending.resolve(frame.result);
        }
        // JSON-RPC responses are transport control data.  Feeding a
        // thread/resume response (which can contain the complete native
        // history) into the Agent event reducer duplicates that history and
        // can exhaust the Gateway heap.  Only notifications and server-side
        // requests belong on the event stream.
        return;
      }
    } catch {
      // Protocol adapters decide whether a non-JSON line is meaningful.
    }
    this.hub.publish(line);
  }

  #finish(error, result = null) {
    if (this.closed) return;
    this.closed = true;
    if (this.buffer) this.#publish(this.buffer);
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(error || new Error("Agent process exited"));
    }
    this.pendingRpc.clear();
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error || new Error("Agent process exited"));
    }
    this.pendingControls.clear();
    if (error || !this.remotePidObserved) this.rejectReady(error || new Error("Agent process exited before reporting its remote PID"));
    this.hub.close(error);
    if (error) this.rejectExit(error);
    else this.resolveExit(result);
  }

  lines(options = {}) {
    return this.hub.subscribe(options);
  }

  discardBufferedLines() {
    this.hub.backlog = [];
    this.hub.backlogBytes = 0;
    this.buffer = "";
  }

  write(value) {
    invariant(!this.closed, "AGENT_PROCESS_CLOSED", "Agent 进程已退出", { status: 409 });
    this.channel.write(Buffer.isBuffer(value) ? value : String(value));
  }

  writeJson(value) {
    this.write(`${JSON.stringify(value)}\n`);
  }

  endInput() {
    if (this.closed || this.inputEnded) return;
    this.inputEnded = true;
    this.channel.end();
  }

  requestControl(frame, timeoutMs = CONTROL_REQUEST_TIMEOUT_MS) {
    invariant(!this.closed, "AGENT_PROCESS_CLOSED", "Agent 进程已退出", { status: 409 });
    const requestId = String(frame?.request_id || "");
    invariant(frame?.type === "control_request" && requestId, "AGENT_CONTROL_REQUEST_INVALID", "Agent 控制请求无效", { status: 400 });
    invariant(!this.pendingControls.has(requestId), "AGENT_CONTROL_REQUEST_DUPLICATE", "Agent 控制请求重复", { status: 409 });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingControls.delete(requestId)) return;
        reject(new ApiError("AGENT_CONTROL_TIMEOUT", "Agent 未及时确认控制请求", {
          status: 504,
          retryable: true,
          details: { requestId, timeoutMs },
        }));
      }, timeoutMs);
      timer.unref?.();
      this.pendingControls.set(requestId, { resolve, reject, timer });
    });
    this.writeJson(frame);
    return promise;
  }

  requestJsonRpc(method, params = {}, timeoutMs = JSON_RPC_TIMEOUT_MS) {
    invariant(!this.closed, "AGENT_PROCESS_CLOSED", "Agent 进程已退出", { status: 409 });
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= JSON_RPC_TIMEOUT_MS, "AGENT_RPC_TIMEOUT_INVALID", "Agent RPC 超时时间无效", { status: 500, expose: false });
    this.rpcSequence += 1;
    const id = this.rpcSequence;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRpc.delete(String(id))) return;
        reject(new ApiError("AGENT_RPC_TIMEOUT", `Agent RPC ${method} 超时`, {
          status: 504,
          retryable: true,
          details: { method, timeoutMs },
        }));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpc.set(String(id), { resolve, reject, timer });
    });
    this.writeJson({ id, method, params });
    return promise;
  }

  notifyJsonRpc(method, params) {
    this.writeJson({ method, ...(params === undefined ? {} : { params }) });
  }

  respondJsonRpc(id, result) {
    invariant(id !== null && id !== undefined && (typeof id === "string" || Number.isSafeInteger(id)), "AGENT_RPC_RESPONSE_ID_INVALID", "Agent RPC 响应 id 无效", { status: 400 });
    this.writeJson({ id, result });
  }

  rejectJsonRpc(id, code, message) {
    invariant(id !== null && id !== undefined && (typeof id === "string" || Number.isSafeInteger(id)), "AGENT_RPC_RESPONSE_ID_INVALID", "Agent RPC 响应 id 无效", { status: 400 });
    invariant(Number.isSafeInteger(code) && typeof message === "string" && message, "AGENT_RPC_ERROR_INVALID", "Agent RPC 错误响应无效", { status: 400 });
    this.writeJson({ id, error: { code, message } });
  }

  async signal(signal = "SIGINT") {
    invariant(!this.closed, "AGENT_PROCESS_CLOSED", "Agent 进程已退出", { status: 409 });
    const normalized = String(signal).replace(/^SIG/, "");
    const remotePid = String(this.processId).match(/^remote-(\d+)$/)?.[1];
    try {
      // ssh2 sends SSH_MSG_CHANNEL_REQUEST without an acknowledgement and its
      // Channel.signal API is deliberately synchronous (there is no callback).
      this.channel.signal(normalized);
    } catch (error) {
      // The PID prelude gives us a verifiable, session-scoped fallback when a
      // server rejects channel signals outright.
      if (!remotePid || !this.session?.exec) throw error;
      const result = await this.session.exec(`kill -${normalized} -- ${remotePid} 2>/dev/null || true`, { maxOutputBytes: 16 * 1024 });
      invariant(result.code === 0, "AGENT_PROCESS_SIGNAL_FAILED", "无法中断远端 Agent", { status: 502, retryable: true });
    }
    // Some SSH servers accept the channel request but do not forward the
    // signal to the remote process.  The PID prelude is scoped to this exact
    // Agent process, so also issue a PID-targeted signal whenever possible.
    // This makes delivery observable instead of treating a fire-and-forget
    // SSH channel request as proof of interruption.
    if (remotePid && this.session?.exec) {
      const result = await this.session.exec(`kill -${normalized} -- ${remotePid} 2>/dev/null || true`, { maxOutputBytes: 16 * 1024 });
      invariant(result.code === 0, "AGENT_PROCESS_SIGNAL_FAILED", "无法中断远端 Agent", { status: 502, retryable: true });
    }
  }

  wait() {
    return this.exit;
  }

  ready() {
    return this.readyPromise;
  }
}

function sftpCall(client, method, ...args) {
  const timeoutMs = method === "fastPut" ? SFTP_UPLOAD_TIMEOUT_MS : SFTP_OPERATION_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new ApiError("SFTP_OPERATION_TIMEOUT", `SFTP ${method} 操作超时`, {
      status: 504,
      retryable: true,
      details: { method, timeoutMs },
    })), timeoutMs);
    try { client[method](...args, (error, result) => finish(error, result)); }
    catch (error) { finish(error); }
  });
}

function parseHttpResponse(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  invariant(headerEnd >= 0, "AGENT_HTTP_RESPONSE_INVALID", "Agent HTTP 响应缺少头部", { status: 502 });
  const headerText = buffer.subarray(0, headerEnd).toString("utf8");
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const rawBody = buffer.subarray(headerEnd + 4);
  return { status, headers, rawBody };
}

function completeHttpResponseLength(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = buffer.subarray(0, headerEnd).toString("utf8");
  const headers = {};
  for (const line of headerText.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const bodyStart = headerEnd + 4;
  if (headers["content-length"] !== undefined) {
    const contentLength = Number(headers["content-length"]);
    invariant(Number.isSafeInteger(contentLength) && contentLength >= 0, "AGENT_HTTP_RESPONSE_INVALID", "Agent HTTP Content-Length 无效", { status: 502 });
    return buffer.length >= bodyStart + contentLength ? bodyStart + contentLength : null;
  }
  if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    let offset = bodyStart;
    while (offset < buffer.length) {
      const lineEnd = buffer.indexOf("\r\n", offset);
      if (lineEnd < 0) return null;
      const chunkLength = Number.parseInt(buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0], 16);
      invariant(Number.isSafeInteger(chunkLength) && chunkLength >= 0, "AGENT_HTTP_RESPONSE_INVALID", "Agent HTTP chunk 长度无效", { status: 502 });
      const chunkStart = lineEnd + 2;
      if (chunkLength === 0) {
        if (buffer.length < chunkStart + 2) return null;
        if (buffer.subarray(chunkStart, chunkStart + 2).equals(Buffer.from("\r\n"))) return chunkStart + 2;
        const trailerEnd = buffer.indexOf("\r\n\r\n", chunkStart);
        return trailerEnd < 0 ? null : trailerEnd + 4;
      }
      const next = chunkStart + chunkLength;
      if (buffer.length < next + 2) return null;
      invariant(buffer.subarray(next, next + 2).equals(Buffer.from("\r\n")), "AGENT_HTTP_RESPONSE_INVALID", "Agent HTTP chunk 边界无效", { status: 502 });
      offset = next + 2;
    }
  }
  return null;
}

function decodeChunked(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const end = body.indexOf("\r\n", offset);
    if (end < 0) break;
    const size = Number.parseInt(body.subarray(offset, end).toString("ascii").split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = end + 2;
    chunks.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(chunks);
}

function httpRequestBytes(request) {
  const body = request.body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
  const headers = {
    Host: `${request.host}:${request.port}`,
    Connection: "close",
    Accept: "application/json",
    ...(body.length ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
    ...(request.headers || {}),
  };
  const head = `${request.method || "GET"} ${request.path || "/"} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head), body]);
}

export class SshAgentExecutor {
  constructor({ session, proxyFactory = null } = {}) {
    invariant(session && typeof session.exec === "function" && typeof session.sftp === "function", "AGENT_SSH_SESSION_INVALID", "Agent executor 需要 SSH session", {
      status: 500,
      expose: false,
    });
    this.session = session;
    this.proxyFactory = proxyFactory;
    this.cachedHome = null;
    this.pendingHome = null;
  }

  async home() {
    if (this.cachedHome) return this.cachedHome;
    if (this.pendingHome) return this.pendingHome;
    this.pendingHome = (async () => {
      const result = await this.session.exec("printf '%s' \"$HOME\"", { maxOutputBytes: 16 * 1024 });
      invariant(result.code === 0 && String(result.stdout).startsWith("/"), "AGENT_REMOTE_HOME_UNAVAILABLE", "无法读取远端 HOME", { status: 502 });
      this.cachedHome = path.posix.normalize(String(result.stdout).trim()).replace(/\/$/, "");
      return this.cachedHome;
    })();
    try { return await this.pendingHome; }
    finally { this.pendingHome = null; }
  }

  exec(command, options = {}) {
    return this.session.exec(command, options);
  }

  async upload(localPath, remotePath) {
    await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`);
    const sftp = await this.session.sftp();
    const temporary = `${remotePath}.upload-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await sftpCall(sftp, "fastPut", localPath, temporary);
    } catch (error) {
      try { await sftpCall(sftp, "unlink", temporary); } catch { /* best effort */ }
      throw error;
    } finally {
      sftp.end?.();
    }
    const replaced = await this.exec(`mv -f -- ${shellQuote(temporary)} ${shellQuote(remotePath)}`);
    if (replaced.code !== 0) {
      await this.exec(`rm -f -- ${shellQuote(temporary)}`).catch(() => undefined);
      throw new ApiError("AGENT_REMOTE_UPLOAD_COMMIT_FAILED", "无法提交远端 Agent 安装包", {
        status: 502,
        details: { exitCode: replaced.code },
      });
    }
  }

  async writeAtomic(remotePath, content, { mode = 0o600, parentPrepared = false } = {}) {
    if (!parentPrepared) await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`);
    const sftp = await this.session.sftp();
    const temporary = `${remotePath}.write-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await sftpCall(sftp, "writeFile", temporary, Buffer.isBuffer(content) ? content : Buffer.from(String(content)), { mode });
    } catch (error) {
      try { await sftpCall(sftp, "unlink", temporary); } catch { /* best effort */ }
      throw error;
    } finally {
      sftp.end?.();
    }
    const replaced = await this.exec(`chmod ${Number(mode).toString(8)} -- ${shellQuote(temporary)} && mv -f -- ${shellQuote(temporary)} ${shellQuote(remotePath)}`);
    if (replaced.code !== 0) {
      await this.exec(`rm -f -- ${shellQuote(temporary)}`).catch(() => undefined);
      throw new ApiError("AGENT_REMOTE_ATOMIC_WRITE_FAILED", "无法原子更新远端 EasyWork 文件", {
        status: 502,
        details: { exitCode: replaced.code },
      });
    }
  }

  async readFile(remotePath) {
    const sftp = await this.session.sftp();
    try {
      return Buffer.from(await sftpCall(sftp, "readFile", remotePath));
    } finally {
      sftp.end?.();
    }
  }

  async spawn(specification) {
    if (typeof this.session.openProcess === "function") return this.session.openProcess(specification);
    const client = this.session.client;
    invariant(client && typeof client.exec === "function", "AGENT_INTERACTIVE_PROCESS_UNAVAILABLE", "SSH transport 不支持交互式 Agent 进程", {
      status: 409,
    });
    const processId = `proc_${crypto.randomBytes(12).toString("hex")}`;
    const channel = typeof this.session.openExec === "function"
      ? await this.session.openExec(commandLine(specification), { pty: false })
      : await new Promise((resolve, reject) => client.exec(commandLine(specification), { pty: false }, (error, opened) => error ? reject(error) : resolve(opened)));
    const process = new SshProcessHandle({ channel, processId, onStderr: specification.onStderr, session: this.session });
    await process.ready();
    return process;
  }

  async spawnDetached(specification) {
    invariant(typeof specification?.logPath === "string" && specification.logPath.startsWith("/"), "AGENT_DETACHED_LOG_REQUIRED", "后台 Agent 进程需要隔离日志路径", {
      status: 400,
    });
    const result = await this.exec(detachedCommandLine(specification), { maxOutputBytes: 16 * 1024 });
    const remotePid = Number(String(result.stdout).match(/__EASYWORK_REMOTE_PID__:(\d+)/)?.[1]);
    invariant(result.code === 0 && Number.isSafeInteger(remotePid) && remotePid > 1, "AGENT_DETACHED_START_FAILED", "无法启动远端 Agent 服务", {
      status: 502,
      details: { exitCode: result.code },
    });
    return new DetachedSshProcessHandle({ executor: this, processId: `remote-${remotePid}`, remotePid });
  }

  async requestHttp(request) {
    const host = request.host || "127.0.0.1";
    invariant(["127.0.0.1", "::1", "localhost"].includes(host), "AGENT_HTTP_HOST_FORBIDDEN", "Agent HTTP 服务必须绑定远端 loopback", { status: 400 });
    const requestedTimeout = request.timeoutMs == null ? HTTP_TIMEOUT_MS : Number(request.timeoutMs);
    const timeoutLimit = request.waitForTurn === true && /^\/session\/[^/]+\/command(?:\?|$)/.test(request.path || "") ? 12 * 60 * 60 * 1000 : HTTP_TIMEOUT_MS;
    invariant(Number.isSafeInteger(requestedTimeout) && requestedTimeout >= 250 && requestedTimeout <= timeoutLimit, "AGENT_HTTP_TIMEOUT_INVALID", "Agent HTTP 请求超时时间无效", { status: 500, expose: false });
    const startedAt = Date.now();
    let openTimedOut = false;
    let openTimer = null;
    const opening = Promise.resolve().then(() => this.session.forwardOut({ destinationHost: host, destinationPort: request.port }));
    const stream = await Promise.race([
      opening.then((opened) => {
        if (openTimedOut) {
          opened?.destroy?.();
          opened?.end?.();
          throw new ApiError("AGENT_HTTP_REQUEST_TIMEOUT", "Agent HTTP 请求超时", {
            status: 504,
            retryable: true,
            details: { port: request.port, path: request.path || "/", timeoutMs: requestedTimeout },
          });
        }
        return opened;
      }),
      new Promise((_, reject) => {
        openTimer = setTimeout(() => {
          openTimedOut = true;
          reject(new ApiError("AGENT_HTTP_REQUEST_TIMEOUT", "Agent HTTP 请求超时", {
            status: 504,
            retryable: true,
            details: { port: request.port, path: request.path || "/", timeoutMs: requestedTimeout },
          }));
        }, requestedTimeout);
        openTimer.unref?.();
      }),
    ]).finally(() => clearTimeout(openTimer));
    const responseTimeout = Math.max(1, requestedTimeout - (Date.now() - startedAt));
    let responseBuffer = Buffer.alloc(0);
    const response = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        stream.destroy();
        finish(null, new ApiError("AGENT_HTTP_REQUEST_TIMEOUT", "Agent HTTP 请求超时", {
          status: 504,
          retryable: true,
          details: { port: request.port, path: request.path || "/", timeoutMs: requestedTimeout },
        }));
      }, responseTimeout);
      const finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      stream.on("data", (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]);
        if (responseBuffer.length > HTTP_LIMIT) {
          stream.destroy();
          finish(null, new ApiError("AGENT_HTTP_RESPONSE_TOO_LARGE", "Agent HTTP 响应过大", { status: 502 }));
          return;
        }
        try {
          const completeLength = completeHttpResponseLength(responseBuffer);
          if (completeLength !== null) {
            const complete = responseBuffer.subarray(0, completeLength);
            finish(complete);
            stream.destroy();
          }
        } catch (error) {
          stream.destroy();
          finish(null, error);
        }
      });
      stream.once("error", (error) => finish(null, error));
      stream.once("end", () => finish(responseBuffer));
      stream.once("close", () => finish(responseBuffer));
    });
    // Do not half-close the SSH forwarded channel after writing the HTTP
    // request. Some loopback Agent servers treat the SSH channel EOF as a
    // disconnected client and close before their response headers reach us.
    // Content-Length makes the request boundary explicit, so keeping the
    // writable side open until the server closes the HTTP/1.1 connection is
    // both valid and necessary for reliable abort/configuration calls.
    stream.write(httpRequestBytes({ ...request, host }));
    const parsed = parseHttpResponse(await response);
    const body = parsed.headers["transfer-encoding"]?.toLowerCase() === "chunked" ? decodeChunked(parsed.rawBody) : parsed.rawBody;
    invariant(parsed.status >= 200 && parsed.status < 300, "AGENT_HTTP_REQUEST_FAILED", `Agent HTTP 请求失败：${parsed.status}`, {
      status: 502,
      expose: true,
      details: { remoteStatus: parsed.status, body: body.toString("utf8").slice(0, 2_000) },
    });
    const text = body.toString("utf8");
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  async openHttpEventStream({ host = "127.0.0.1", port, path: requestPath = "/event" }) {
    invariant(["127.0.0.1", "::1", "localhost"].includes(host), "AGENT_HTTP_HOST_FORBIDDEN", "Agent event stream 必须绑定远端 loopback", { status: 400 });
    const stream = await this.session.forwardOut({ destinationHost: host, destinationPort: port });
    const queue = new AsyncQueue(
      () => stream.destroy(),
      { onOverflow: () => stream.destroy() },
    );
    let buffer = "";
    let headersComplete = false;
    stream.on("data", (chunk) => {
      buffer += Buffer.from(chunk).toString("utf8");
      if (!headersComplete) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const status = Number(buffer.slice(0, headerEnd).split(" ")[1]);
        if (!(status >= 200 && status < 300)) {
          queue.end(new ApiError("AGENT_EVENT_STREAM_FAILED", `Agent event stream 返回 ${status}`, { status: 502 }));
          stream.destroy();
          return;
        }
        headersComplete = true;
        buffer = buffer.slice(headerEnd + 4);
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) queue.push(line);
        newline = buffer.indexOf("\n");
      }
    });
    stream.once("error", (error) => queue.end(error));
    stream.once("close", () => queue.end());
    stream.write(httpRequestBytes({
      method: "GET",
      host,
      port,
      path: requestPath,
      headers: { Accept: "text/event-stream", Connection: "keep-alive" },
    }));
    return queue;
  }

  async probeTcp({ host, port }) {
    invariant(typeof host === "string" && host.length > 0 && Number.isSafeInteger(port) && port > 0 && port <= 65_535, "AGENT_API_PROBE_TARGET_INVALID", "Agent API 探测目标无效", { status: 400 });
    let stream;
    try {
      stream = await this.session.forwardOut({ destinationHost: host, destinationPort: port });
      return true;
    } catch {
      return false;
    } finally {
      stream?.destroy?.();
      stream?.end?.();
    }
  }

  async openLoopbackProxy(descriptor) {
    const factory = this.proxyFactory || (typeof this.session.openLoopbackProxy === "function"
      ? (request) => this.session.openLoopbackProxy(request)
      : null);
    invariant(typeof factory === "function", "AGENT_API_PROXY_UNAVAILABLE", "主机未配置 SSH loopback API proxy", {
      status: 409,
      details: { reason: "proxy_factory_unavailable" },
    });
    const proxy = await factory({ session: this.session, ...descriptor, bindHost: "127.0.0.1" });
    invariant(proxy && ["127.0.0.1", "::1", "localhost"].includes(proxy.host) && Number.isSafeInteger(proxy.port) && ["http", "https"].includes(proxy.protocol || "http") && typeof proxy.endpointPath === "string", "AGENT_API_PROXY_INVALID", "SSH API proxy 未绑定 loopback", {
      status: 500,
      expose: false,
    });
    return proxy;
  }
}

export { AsyncQueue, LineHub, SshProcessHandle, commandLine, shellQuote };
