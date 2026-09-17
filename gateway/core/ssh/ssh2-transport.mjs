import crypto from "node:crypto";
import net from "node:net";

import { Client as Ssh2Client } from "ssh2";

import { ApiError, invariant } from "../errors.mjs";
import { createHostApiRelay } from "./api-reverse-proxy.mjs";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_PTY_INPUT_BYTES = 64 * 1024;
// OpenSSH defaults MaxSessions to 10. Background channels may occupy eight;
// exec channels can use the two reserved slots so a retained terminal/SFTP
// stream cannot make a healthy SSH connection reject the next user command.
const MAX_BACKGROUND_SESSION_CHANNELS = 8;
const MAX_CONCURRENT_SESSION_CHANNELS = 10;
const SESSION_CHANNEL_WAIT_TIMEOUT_MS = 15_000;
const SESSION_CHANNEL_OPEN_TIMEOUT_MS = 15_000;
const CHANNEL_OPEN_RETRY_DELAYS_MS = Object.freeze([0, 120, 320, 750, 1_500]);

function channelOpenWasRefused(error) {
  return /channel open failure|open failed|administratively prohibited|resource shortage/i.test(String(error?.message || error || ""));
}

function wait(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      reject(Object.assign(new Error("SSH 命令已中断"), { code: "SSH_COMMAND_ABORTED", status: 409 }));
    };
    function done() {
      signal?.removeEventListener?.("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener?.("abort", abort, { once: true });
  });
}

function ptyDimension(value, fallback, field) {
  const result = Number(value ?? fallback);
  invariant(Number.isSafeInteger(result) && result > 0 && result <= 10_000, "SSH_PTY_DIMENSION_INVALID", `${field} 无效`, { status: 400 });
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ptyWorkingDirectory(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value);
  invariant(result.startsWith("/") && result.length <= 4_096 && !/[\0\r\n]/.test(result), "SSH_PTY_CWD_INVALID", "PTY 工作目录无效", { status: 400 });
  return result;
}

class SshPtyHandle {
  constructor(channel, descriptor) {
    this.channel = channel;
    this.descriptor = { ...descriptor };
    this.closed = false;
    this.dataListeners = new Set();
    this.closeListeners = new Set();
    channel.on("data", (chunk) => this.#publish("stdout", chunk));
    channel.stderr?.on("data", (chunk) => this.#publish("stderr", chunk));
    channel.once("error", (error) => this.#close(safeError(error, "SSH_PTY_FAILED")));
    channel.once("close", (code, signal) => this.#close(null, { code: Number.isInteger(code) ? code : null, signal: signal || null }));
  }

  #publish(stream, chunk) {
    if (this.closed) return;
    const bytes = Buffer.from(chunk);
    for (const listener of this.dataListeners) listener({ stream, bytes });
  }

  #close(error = null, result = null) {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error, result);
    this.dataListeners.clear();
    this.closeListeners.clear();
  }

  onData(listener) {
    invariant(typeof listener === "function", "SSH_PTY_LISTENER_INVALID", "PTY 输出监听器无效", { status: 500, expose: false });
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener) {
    invariant(typeof listener === "function", "SSH_PTY_LISTENER_INVALID", "PTY 关闭监听器无效", { status: 500, expose: false });
    if (this.closed) queueMicrotask(() => listener(null, null));
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  write(value) {
    invariant(!this.closed, "SSH_PTY_CLOSED", "PTY 已关闭", { status: 409 });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    invariant(bytes.length > 0 && bytes.length <= MAX_PTY_INPUT_BYTES, "SSH_PTY_INPUT_INVALID", "PTY 单次输入大小无效", {
      status: bytes.length > MAX_PTY_INPUT_BYTES ? 413 : 400,
      details: { maxBytes: MAX_PTY_INPUT_BYTES },
    });
    this.channel.write(bytes);
    return bytes.length;
  }

  resize(input = {}) {
    invariant(!this.closed, "SSH_PTY_CLOSED", "PTY 已关闭", { status: 409 });
    const rows = ptyDimension(input.rows, this.descriptor.rows, "rows");
    const cols = ptyDimension(input.cols, this.descriptor.cols, "cols");
    this.channel.setWindow(rows, cols, 0, 0);
    this.descriptor = { ...this.descriptor, rows, cols };
    return { rows, cols };
  }

  async close() {
    if (this.closed) return;
    this.channel.end?.();
    this.channel.close?.();
  }
}

function hostFingerprint(publicKey) {
  return `SHA256:${crypto.createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;
}

function safeError(error, fallbackCode = "SSH_CONNECTION_FAILED") {
  const source = error instanceof Error ? error : new Error(String(error || "SSH 操作失败"));
  const message = String(source.message || "SSH 操作失败").slice(0, 2_000);
  if (source.code === "SSH_HOST_KEY_CONFIRMATION_REQUIRED") {
    return Object.assign(new Error(message), { code: source.code, status: 409, details: source.details, cause: source });
  }
  let code = source.code || fallbackCode;
  if (/authentication|all configured authentication/i.test(message)) code = "SSH_AUTH_FAILED";
  if (/timed?\s*out|timeout/i.test(message)) code = "SSH_TIMEOUT";
  return Object.assign(new Error(message), {
    code,
    status: Number.isInteger(source.status) ? source.status : code === "SSH_AUTH_FAILED" ? 401 : 502,
    ...(source.details ? { details: source.details } : {}),
    cause: source,
  });
}

function captureChunk(chunks, chunk, state, maxBytes) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.bytes += value.length;
  invariant(state.bytes <= maxBytes, "SSH_OUTPUT_TOO_LARGE", "SSH 命令输出超过捕获上限", { status: 413 });
  chunks.push(value);
}

function answerInteractive(prompts, credential, twoFactorCode) {
  return prompts.map((prompt) => {
    const text = String(prompt?.prompt || "");
    if (/verification|one.?time|otp|2fa|动态|验证码|token/i.test(text)) return String(twoFactorCode || "");
    if (/password|密码/i.test(text)) return credential.method === "password" ? credential.password : String(credential.passphrase || "");
    return twoFactorCode ? String(twoFactorCode) : "";
  });
}

class Ssh2Session {
  constructor({ client, fingerprint, forwardConnectTimeoutMs = 5_000 }) {
    this.client = client;
    this.fingerprint = fingerprint;
    this.forwardConnectTimeoutMs = forwardConnectTimeoutMs;
    this.closed = false;
    this.closeListeners = new Set();
    this.apiProxies = new Map();
    this.activeSessionChannels = 0;
    this.sessionChannelWaiters = [];
    this.sessionChannelPressureHandler = null;
    this.sessionChannelPressureRelief = null;
    client.on("tcp connection", (details, accept, reject) => this.#acceptReverseConnection(details, accept, reject));
    client.once("close", () => {
      this.closed = true;
      this.#rejectSessionChannelWaiters();
      void this.#closeApiProxies();
      for (const listener of this.closeListeners) listener(null);
    });
    client.once("error", (error) => {
      if (this.closed) return;
      for (const listener of this.closeListeners) listener(safeError(error));
    });
  }

  onClose(listener) {
    if (typeof listener === "function") this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  setSessionChannelPressureHandler(handler) {
    invariant(handler === null || handler === undefined || typeof handler === "function", "SSH_CHANNEL_PRESSURE_HANDLER_INVALID", "SSH 通道回收处理器无效", { status: 500, expose: false });
    this.sessionChannelPressureHandler = typeof handler === "function" ? handler : null;
    return () => {
      if (this.sessionChannelPressureHandler === handler) this.sessionChannelPressureHandler = null;
    };
  }

  async isAlive() {
    return !this.closed;
  }

  #rejectSessionChannelWaiters() {
    const error = safeError(Object.assign(new Error("SSH 连接已关闭"), { code: "SSH_CONNECTION_CLOSED", status: 409 }));
    for (const waiter of this.sessionChannelWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener?.("abort", waiter.abort);
      waiter.reject(error);
    }
  }

  #sessionSlotRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSessionChannels = Math.max(0, this.activeSessionChannels - 1);
      while (this.sessionChannelWaiters.length) {
        // Foreground execs get the reserved capacity first. Background PTY or
        // SFTP work remains capped at eight even when the server has room for
        // two more command channels.
        let index = this.activeSessionChannels < MAX_CONCURRENT_SESSION_CHANNELS
          ? this.sessionChannelWaiters.findIndex((waiter) => waiter.priority)
          : -1;
        if (index < 0 && this.activeSessionChannels < MAX_BACKGROUND_SESSION_CHANNELS) {
          index = this.sessionChannelWaiters.findIndex((waiter) => !waiter.priority);
        }
        if (index < 0) break;
        const [waiter] = this.sessionChannelWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener?.("abort", waiter.abort);
        if (waiter.signal?.aborted) continue;
        this.activeSessionChannels += 1;
        waiter.resolve(this.#sessionSlotRelease());
        break;
      }
    };
  }

  async #relieveSessionChannelPressure(limit, reason) {
    if (!this.sessionChannelPressureHandler) return false;
    if (!this.sessionChannelPressureRelief) {
      const relief = Promise.resolve()
        .then(() => this.sessionChannelPressureHandler?.({ active: this.activeSessionChannels, limit, reason }))
        .then(Boolean, () => false)
        .finally(() => {
          if (this.sessionChannelPressureRelief === relief) this.sessionChannelPressureRelief = null;
        });
      this.sessionChannelPressureRelief = relief;
    }
    return this.sessionChannelPressureRelief;
  }

  async #acquireSessionSlot(signal, priority = false) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    if (signal?.aborted) throw Object.assign(new Error("SSH 命令已中断"), { code: "SSH_COMMAND_ABORTED", status: 409 });
    const limit = priority ? MAX_CONCURRENT_SESSION_CHANNELS : MAX_BACKGROUND_SESSION_CHANNELS;
    if (priority && this.activeSessionChannels >= limit && this.sessionChannelPressureHandler) {
      await this.#relieveSessionChannelPressure(limit, "local-limit");
      invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
      if (signal?.aborted) throw Object.assign(new Error("SSH 命令已中断"), { code: "SSH_COMMAND_ABORTED", status: 409 });
    }
    if (this.activeSessionChannels < limit) {
      this.activeSessionChannels += 1;
      return this.#sessionSlotRelease();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, priority, abort: null, timer: null };
      const fail = (error) => {
        const index = this.sessionChannelWaiters.indexOf(waiter);
        if (index >= 0) this.sessionChannelWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        signal?.removeEventListener?.("abort", waiter.abort);
        reject(error);
      };
      waiter.abort = () => {
        fail(Object.assign(new Error("SSH 命令已中断"), { code: "SSH_COMMAND_ABORTED", status: 409 }));
      };
      waiter.timer = setTimeout(() => fail(new ApiError("SSH_CHANNEL_SLOT_TIMEOUT", "SSH 已连接，但可用执行通道暂时占满，请稍后重试", {
        status: 504,
        retryable: true,
        details: { limit, timeoutMs: SESSION_CHANNEL_WAIT_TIMEOUT_MS },
      })), SESSION_CHANNEL_WAIT_TIMEOUT_MS);
      signal?.addEventListener?.("abort", waiter.abort, { once: true });
      this.sessionChannelWaiters.push(waiter);
    });
  }

  async #openSessionChannel(open, options = {}) {
    let lastError = null;
    let pressureReliefAttempted = false;
    for (let attempt = 0; attempt < CHANNEL_OPEN_RETRY_DELAYS_MS.length; attempt += 1) {
      await wait(CHANNEL_OPEN_RETRY_DELAYS_MS[attempt], options.signal);
      const release = await this.#acquireSessionSlot(options.signal, options.priority === true);
      try {
        const channel = await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, opened) => {
            if (settled) {
              opened?.destroy?.();
              opened?.end?.();
              return;
            }
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener?.("abort", abort);
            if (error) reject(error);
            else resolve(opened);
          };
          const abort = () => finish(Object.assign(new Error("SSH 命令已中断"), { code: "SSH_COMMAND_ABORTED", status: 409 }));
          const timer = setTimeout(() => finish(new ApiError("SSH_CHANNEL_OPEN_TIMEOUT", "SSH 会话通道打开超时", {
            status: 504,
            retryable: true,
            details: { timeoutMs: SESSION_CHANNEL_OPEN_TIMEOUT_MS },
          })), SESSION_CHANNEL_OPEN_TIMEOUT_MS);
          if (options.signal?.aborted) abort();
          else {
            options.signal?.addEventListener?.("abort", abort, { once: true });
            try { open((error, opened) => finish(error, opened)); }
            catch (error) { finish(error); }
          }
        });
        channel.once?.("close", release);
        channel.once?.("end", release);
        channel.once?.("error", release);
        return channel;
      } catch (error) {
        release();
        lastError = error;
        if (!pressureReliefAttempted
          && options.priority === true
          && this.activeSessionChannels > 0
          && channelOpenWasRefused(error)
          && this.sessionChannelPressureHandler) {
          pressureReliefAttempted = true;
          await this.#relieveSessionChannelPressure(MAX_CONCURRENT_SESSION_CHANNELS, "server-refused");
        }
        if (!channelOpenWasRefused(error) || attempt === CHANNEL_OPEN_RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError || new Error("SSH channel 无法打开");
  }

  async openExec(command, options = {}) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    try {
      return await this.#openSessionChannel(
        (callback) => this.client.exec(command, { env: options.env, pty: options.pty || false }, callback),
        { ...options, priority: options.priority !== false },
      );
    } catch (error) {
      throw safeError(error, "SSH_COMMAND_FAILED");
    }
  }

  async exec(command, options = {}) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    const maxBytes = Number(options.maxOutputBytes || MAX_CAPTURE_BYTES);
    invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, "SSH_CAPTURE_LIMIT_INVALID", "SSH 输出上限无效", { status: 400 });
    const stream = await this.openExec(command, { env: options.env, pty: options.pty || false, signal: options.signal });
    return new Promise((resolve, reject) => {
      let settled = false;
      const stdout = [];
      const stderr = [];
      const state = { bytes: 0 };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener?.("abort", abort);
        if (error) reject(safeError(error, "SSH_COMMAND_FAILED"));
        else resolve(result);
      };
      const abort = () => {
        stream?.signal?.("INT");
        stream?.close?.();
        finish(Object.assign(new Error("SSH 命令已中断"), { code: "SSH_COMMAND_ABORTED", status: 409 }));
      };
      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener?.("abort", abort, { once: true });
      stream.on("data", (chunk) => {
          try {
            captureChunk(stdout, chunk, state, maxBytes);
            options.onStdout?.(Buffer.from(chunk));
          } catch (captureError) {
            stream.close?.();
            finish(captureError);
          }
        });
      stream.stderr?.on("data", (chunk) => {
          try {
            captureChunk(stderr, chunk, state, maxBytes);
            options.onStderr?.(Buffer.from(chunk));
          } catch (captureError) {
            stream.close?.();
            finish(captureError);
          }
        });
      stream.once("error", (channelError) => finish(channelError));
      stream.once("close", (code, signal) => finish(null, {
          stdout: Buffer.concat(stdout).toString(options.encoding || "utf8"),
          stderr: Buffer.concat(stderr).toString(options.encoding || "utf8"),
          code: Number.isInteger(code) ? code : null,
          signal: signal || null,
        }));
    });
  }

  async sftp(options = {}) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    try {
      return await this.#openSessionChannel((callback) => this.client.sftp(callback), { ...options, priority: options.priority === true });
    } catch (error) {
      throw safeError(error, "SFTP_OPEN_FAILED");
    }
  }

  async openPty(options = {}) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    const term = String(options.term || "xterm-256color");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(term), "SSH_PTY_TERM_INVALID", "PTY TERM 无效", { status: 400 });
    const rows = ptyDimension(options.rows, 24, "rows");
    const cols = ptyDimension(options.cols, 80, "cols");
    const cwd = ptyWorkingDirectory(options.cwd);
    invariant(Object.keys(options).every((key) => ["term", "rows", "cols", "cwd"].includes(key)), "SSH_PTY_OPTIONS_INVALID", "PTY 选项无效", { status: 400 });
    const descriptor = { term, rows, cols, ...(cwd ? { cwd } : {}) };
    const pty = { term, rows, cols, width: 0, height: 0 };
    const open = cwd
      ? (callback) => this.client.exec(`cd -- ${shellQuote(cwd)} && exec "\${SHELL:-/bin/sh}" -l`, { pty }, callback)
      : (callback) => this.client.shell(pty, callback);
    try {
      return new SshPtyHandle(await this.#openSessionChannel(open), descriptor);
    } catch (error) {
      throw safeError(error, "SSH_PTY_OPEN_FAILED");
    }
  }

  async forwardOut({ sourceHost = "127.0.0.1", sourcePort = 0, destinationHost, destinationPort }) {
    invariant(destinationHost && Number.isSafeInteger(destinationPort), "SSH_FORWARD_TARGET_INVALID", "SSH 转发目标无效", { status: 400 });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new ApiError("SSH_FORWARD_TIMEOUT", "SSH 转发目标连接超时", {
          status: 504,
          retryable: true,
          details: { destinationHost, destinationPort },
        }));
      }, this.forwardConnectTimeoutMs);
      this.client.forwardOut(sourceHost, sourcePort, destinationHost, destinationPort, (error, stream) => {
        if (settled) {
          stream?.destroy?.();
          stream?.end?.();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) reject(safeError(error, "SSH_FORWARD_FAILED"));
        else resolve(stream);
      });
    });
  }

  async openLoopbackProxy({ bindingId, baseUrl, apiKey, onEffortAdapted = null }) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    const key = String(bindingId || "");
    invariant(key, "AGENT_API_PROXY_BINDING_REQUIRED", "Agent API proxy 缺少 bindingId", { status: 400 });
    const routeFingerprint = crypto.createHash("sha256").update(String(baseUrl || "")).update("\0").update(String(apiKey || "")).digest("hex");
    const existing = this.apiProxies.get(key);
    if (existing?.routeFingerprint === routeFingerprint) {
      existing.relay.setEffortAdaptationHandler?.(onEffortAdapted);
      return existing.publicHandle;
    }
    if (existing) await this.#closeApiProxy(key, existing);

    const relay = await createHostApiRelay({ baseUrl, apiKey, onEffortAdapted });
    let remotePort;
    try {
      remotePort = await new Promise((resolve, reject) => this.client.forwardIn("127.0.0.1", 0, (error, allocatedPort) => {
        if (error) reject(safeError(error, "SSH_REVERSE_FORWARD_FAILED"));
        else resolve(Number(allocatedPort));
      }));
      invariant(Number.isSafeInteger(remotePort) && remotePort > 0 && remotePort <= 65_535, "SSH_REVERSE_FORWARD_INVALID", "SSH server 未返回有效的反向转发端口", {
        status: 502,
      });
    } catch (error) {
      await relay.close();
      throw error;
    }
    const entry = {
      routeFingerprint,
      relay,
      remoteHost: "127.0.0.1",
      remotePort,
      closed: false,
      publicHandle: null,
    };
    entry.publicHandle = Object.freeze({
      host: entry.remoteHost,
      port: entry.remotePort,
      protocol: relay.protocol,
      endpointPath: relay.endpointPath,
      isClosed: () => entry.closed || this.closed,
      setEffortAdaptationHandler: (handler) => relay.setEffortAdaptationHandler?.(handler),
      close: () => this.#closeApiProxy(key, entry),
    });
    this.apiProxies.set(key, entry);
    return entry.publicHandle;
  }

  #acceptReverseConnection(details, accept, reject) {
    const destinationHost = String(details?.destIP || details?.destAddr || "");
    const destinationPort = Number(details?.destPort);
    const entry = [...this.apiProxies.values()].find((candidate) => (
      !candidate.closed
      && candidate.remotePort === destinationPort
      && ["127.0.0.1", "::1", "localhost"].includes(destinationHost)
    ));
    if (!entry) {
      reject?.();
      return;
    }
    const channel = accept();
    const socket = net.connect(entry.relay.port, entry.relay.host);
    const close = () => {
      channel.destroy?.();
      socket.destroy();
    };
    channel.once("error", close);
    socket.once("error", close);
    channel.pipe(socket).pipe(channel);
  }

  async #closeApiProxy(key, entry) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (this.apiProxies.get(key) === entry) this.apiProxies.delete(key);
    await Promise.allSettled([
      new Promise((resolve) => {
        if (this.closed || typeof this.client.unforwardIn !== "function") return resolve();
        this.client.unforwardIn(entry.remoteHost, entry.remotePort, () => resolve());
      }),
      entry.relay.close(),
    ]);
  }

  async #closeApiProxies() {
    await Promise.allSettled([...this.apiProxies.entries()].map(([key, entry]) => this.#closeApiProxy(key, entry)));
  }

  async keepAlive() {
    const result = await this.exec("true", { maxOutputBytes: 1024, priority: false });
    invariant(result.code === 0, "SSH_KEEPALIVE_FAILED", "SSH keepalive 失败", { status: 502 });
  }

  async close() {
    if (this.closed) return;
    this.sessionChannelPressureHandler = null;
    await this.#closeApiProxies();
    this.closed = true;
    this.client.end();
  }
}

export class Ssh2TransportFactory {
  constructor({ ClientClass = Ssh2Client, readyTimeoutMs = 20_000, forwardConnectTimeoutMs = 5_000 } = {}) {
    this.ClientClass = ClientClass;
    this.readyTimeoutMs = readyTimeoutMs;
    this.forwardConnectTimeoutMs = forwardConnectTimeoutMs;
  }

  async connect(request) {
    invariant(request?.profile && request?.credential, "SSH_CONNECT_INPUT_INVALID", "SSH 连接参数不完整", { status: 400 });
    const client = new this.ClientClass();
    const credential = request.credential;
    let observedFingerprint = null;
    const config = {
      host: request.resolvedAddress || request.profile.host,
      port: request.profile.port,
      username: request.profile.username,
      readyTimeout: this.readyTimeoutMs,
      keepaliveInterval: request.keepAliveIntervalMs || 0,
      keepaliveCountMax: 3,
      tryKeyboard: Boolean(request.twoFactorCode),
      hostVerifier: (key) => {
        observedFingerprint = hostFingerprint(key);
        const trustedFingerprint = request.expectedFingerprint || request.acceptedFingerprint;
        return Boolean(trustedFingerprint && trustedFingerprint === observedFingerprint);
      },
      ...(credential.method === "password"
        ? { password: credential.password }
        : { privateKey: credential.privateKey, passphrase: credential.passphrase || undefined }),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, session) => {
        if (settled) return;
        settled = true;
        if (error) {
          client.end();
          reject(safeError(error));
        } else resolve(session);
      };
      client.once("ready", () => finish(null, new Ssh2Session({
        client,
        fingerprint: observedFingerprint,
        forwardConnectTimeoutMs: this.forwardConnectTimeoutMs,
      })));
      client.once("error", (error) => {
        if (observedFingerprint && request.expectedFingerprint && request.expectedFingerprint !== observedFingerprint) {
          finish(Object.assign(new Error("服务器主机指纹已变化"), {
            code: "SSH_HOST_KEY_CHANGED",
            status: 409,
            details: { serverId: request.profile.id },
          }));
          return;
        }
        if (observedFingerprint && !request.expectedFingerprint && !request.acceptedFingerprint) {
          finish(Object.assign(new Error("请确认 SSH 主机指纹后重新连接"), {
            code: "SSH_HOST_KEY_CONFIRMATION_REQUIRED",
            status: 409,
            details: { serverId: request.profile.id, fingerprint: observedFingerprint },
          }));
          return;
        }
        finish(error);
      });
      client.on("keyboard-interactive", (_name, _instructions, _language, prompts, done) => done(answerInteractive(prompts, credential, request.twoFactorCode)));
      try {
        client.connect(config);
      } catch (error) {
        finish(error);
      }
    });
  }
}

export { SshPtyHandle, hostFingerprint };
