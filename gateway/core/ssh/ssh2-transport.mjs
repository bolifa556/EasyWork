import crypto from "node:crypto";
import net from "node:net";

import { Client as Ssh2Client } from "ssh2";

import { ApiError, invariant } from "../errors.mjs";
import { createHostApiRelay } from "./api-reverse-proxy.mjs";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_PTY_INPUT_BYTES = 64 * 1024;

function ptyDimension(value, fallback, field) {
  const result = Number(value ?? fallback);
  invariant(Number.isSafeInteger(result) && result > 0 && result <= 10_000, "SSH_PTY_DIMENSION_INVALID", `${field} 无效`, { status: 400 });
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
    client.on("tcp connection", (details, accept, reject) => this.#acceptReverseConnection(details, accept, reject));
    client.once("close", () => {
      this.closed = true;
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

  async isAlive() {
    return !this.closed;
  }

  async exec(command, options = {}) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    const maxBytes = Number(options.maxOutputBytes || MAX_CAPTURE_BYTES);
    invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, "SSH_CAPTURE_LIMIT_INVALID", "SSH 输出上限无效", { status: 400 });
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream;
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
      this.client.exec(command, { env: options.env, pty: options.pty || false }, (error, channel) => {
        if (error) return finish(error);
        stream = channel;
        channel.on("data", (chunk) => {
          try {
            captureChunk(stdout, chunk, state, maxBytes);
            options.onStdout?.(Buffer.from(chunk));
          } catch (captureError) {
            channel.close?.();
            finish(captureError);
          }
        });
        channel.stderr?.on("data", (chunk) => {
          try {
            captureChunk(stderr, chunk, state, maxBytes);
            options.onStderr?.(Buffer.from(chunk));
          } catch (captureError) {
            channel.close?.();
            finish(captureError);
          }
        });
        channel.once("error", (channelError) => finish(channelError));
        channel.once("close", (code, signal) => finish(null, {
          stdout: Buffer.concat(stdout).toString(options.encoding || "utf8"),
          stderr: Buffer.concat(stderr).toString(options.encoding || "utf8"),
          code: Number.isInteger(code) ? code : null,
          signal: signal || null,
        }));
      });
    });
  }

  async sftp() {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    return new Promise((resolve, reject) => this.client.sftp((error, client) => error ? reject(safeError(error, "SFTP_OPEN_FAILED")) : resolve(client)));
  }

  async openPty(options = {}) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    const term = String(options.term || "xterm-256color");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(term), "SSH_PTY_TERM_INVALID", "PTY TERM 无效", { status: 400 });
    const rows = ptyDimension(options.rows, 24, "rows");
    const cols = ptyDimension(options.cols, 80, "cols");
    invariant(Object.keys(options).every((key) => ["term", "rows", "cols"].includes(key)), "SSH_PTY_OPTIONS_INVALID", "PTY 不接受命令、工作目录或自定义环境", { status: 400 });
    return new Promise((resolve, reject) => this.client.shell({ term, rows, cols, width: 0, height: 0 }, (error, channel) => {
      if (error) reject(safeError(error, "SSH_PTY_OPEN_FAILED"));
      else resolve(new SshPtyHandle(channel, { term, rows, cols }));
    }));
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

  async openLoopbackProxy({ bindingId, baseUrl, apiKey }) {
    invariant(!this.closed, "SSH_CONNECTION_CLOSED", "SSH 连接已关闭", { status: 409 });
    const key = String(bindingId || "");
    invariant(key, "AGENT_API_PROXY_BINDING_REQUIRED", "Agent API proxy 缺少 bindingId", { status: 400 });
    const routeFingerprint = crypto.createHash("sha256").update(String(baseUrl || "")).update("\0").update(String(apiKey || "")).digest("hex");
    const existing = this.apiProxies.get(key);
    if (existing?.routeFingerprint === routeFingerprint) return existing.publicHandle;
    if (existing) await this.#closeApiProxy(key, existing);

    const relay = await createHostApiRelay({ baseUrl, apiKey });
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
    const result = await this.exec("true", { maxOutputBytes: 1024 });
    invariant(result.code === 0, "SSH_KEEPALIVE_FAILED", "SSH keepalive 失败", { status: 502 });
  }

  async close() {
    if (this.closed) return;
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
