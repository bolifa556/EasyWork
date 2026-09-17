import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { Ssh2TransportFactory, hostFingerprint } from "../gateway/core/ssh/index.mjs";

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.reverseForwards = [];
    this.closedReverseForwards = [];
  }

  connect(config) {
    this.config = config;
    const accepted = config.hostVerifier(Buffer.from("host-public-key"));
    if (!accepted) return queueMicrotask(() => this.emit("error", new Error("Host key verification failed")));
    queueMicrotask(() => this.emit("ready"));
  }

  exec(command, _options, callback) {
    this.command = command;
    const channel = new FakeChannel();
    callback(null, channel);
    // `session.exec()` attaches capture listeners after the channel-open
    // promise unwinds through the bounded channel scheduler. Emit on the next
    // event-loop turn so this fake matches ssh2's asynchronous channel I/O
    // instead of racing the consumer with a microtask-only close.
    setImmediate(() => {
      channel.emit("data", Buffer.from("hello"));
      channel.stderr.emit("data", Buffer.from("warn"));
      channel.emit("close", 0, null);
    });
  }

  sftp(callback) { callback(null, { kind: "sftp" }); }
  forwardOut(_sourceHost, _sourcePort, _destinationHost, _destinationPort, callback) { callback(null, { kind: "stream" }); }
  forwardIn(host, port, callback) {
    this.reverseForwards.push({ host, port });
    callback(null, 41001);
  }
  unforwardIn(host, port, callback) {
    this.closedReverseForwards.push({ host, port });
    callback(null);
  }
  end() { this.emit("close"); }
}

const request = {
  profile: { host: "example.internal", port: 22, username: "alice" },
  credential: { method: "password", password: "secret" },
  resolvedAddress: "192.0.2.10",
  acceptedFingerprint: hostFingerprint(Buffer.from("host-public-key")),
};

test("ssh2 transport pins resolved address and exposes only the observed SHA256 host key", async () => {
  const factory = new Ssh2TransportFactory({ ClientClass: FakeClient });
  const session = await factory.connect(request);
  assert.equal(session.fingerprint, hostFingerprint(Buffer.from("host-public-key")));
  assert.equal(session.client.config.host, "192.0.2.10");
  const result = await session.exec("printf hello");
  assert.deepEqual(result, { stdout: "hello", stderr: "warn", code: 0, signal: null });
  assert.deepEqual(await session.sftp(), { kind: "sftp" });
  await session.close();
  assert.equal(await session.isAlive(), false);
});

test("ssh2 transport leaves room for terminal, monitoring, downloads and a foreground Agent", async () => {
  class ConcurrentClient extends FakeClient {
    constructor() {
      super();
      this.channels = [];
    }
    exec(_command, _options, callback) {
      const channel = new FakeChannel();
      this.channels.push(channel);
      callback(null, channel);
    }
    sftp(callback) {
      const channel = new FakeChannel();
      this.channels.push(channel);
      callback(null, channel);
    }
  }
  const factory = new Ssh2TransportFactory({ ClientClass: ConcurrentClient });
  const session = await factory.connect(request);
  const background = await Promise.all(Array.from({ length: 8 }, () => session.sftp()));
  const foreground = await Promise.all([
    session.openExec("foreground-agent-1"),
    session.openExec("foreground-agent-2"),
  ]);
  assert.equal(session.client.channels.length, 10, "two reserved channels remain available to user commands");

  let overflowOpened = false;
  const overflow = session.openExec("foreground-agent-3").then((channel) => {
    overflowOpened = true;
    return channel;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overflowOpened, false, "an eleventh server-side session still waits for capacity");
  background[0].emit("close", 0, null);
  const admitted = await overflow;
  assert.equal(overflowOpened, true);

  for (const channel of [...background.slice(1), ...foreground, admitted]) channel.emit("close", 0, null);
  await session.close();
});

test("ssh2 transport asks the runtime to reclaim one idle channel only when the server limit is full", async () => {
  class ConcurrentClient extends FakeClient {
    constructor() {
      super();
      this.channels = [];
    }
    exec(_command, _options, callback) {
      const channel = new FakeChannel();
      this.channels.push(channel);
      callback(null, channel);
    }
  }
  const factory = new Ssh2TransportFactory({ ClientClass: ConcurrentClient });
  const session = await factory.connect(request);
  const occupied = await Promise.all(Array.from({ length: 10 }, (_, index) => session.openExec(`agent-${index}`)));
  let reclaimed = 0;
  session.setSessionChannelPressureHandler(() => {
    reclaimed += 1;
    occupied[0].emit("close", 0, null);
    return true;
  });

  const replacement = await session.openExec("foreground-command");
  assert.equal(reclaimed, 1);
  assert.equal(session.client.channels.length, 11);

  for (const channel of [...occupied.slice(1), replacement]) channel.emit("close", 0, null);
  await session.close();
});

test("ssh2 transport also reclaims one idle Agent when the server reports a lower session limit", async () => {
  class LowerLimitClient extends FakeClient {
    constructor() {
      super();
      this.channels = [];
      this.execCalls = 0;
    }
    exec(_command, _options, callback) {
      this.execCalls += 1;
      if (this.execCalls === 2) {
        callback(new Error("Channel open failure: resource shortage"));
        return;
      }
      const channel = new FakeChannel();
      this.channels.push(channel);
      callback(null, channel);
    }
  }
  const factory = new Ssh2TransportFactory({ ClientClass: LowerLimitClient });
  const session = await factory.connect(request);
  const idle = await session.openExec("idle-agent");
  let reclaimed = 0;
  session.setSessionChannelPressureHandler(() => {
    reclaimed += 1;
    idle.emit("close", 0, null);
    return true;
  });

  const replacement = await session.openExec("foreground-command");
  assert.equal(reclaimed, 1);
  assert.equal(session.client.execCalls, 3);
  replacement.emit("close", 0, null);
  await session.close();
});

test("ssh2 transport rejects a changed host key before authentication is accepted", async () => {
  const factory = new Ssh2TransportFactory({ ClientClass: FakeClient });
  await assert.rejects(() => factory.connect({ ...request, acceptedFingerprint: undefined, expectedFingerprint: "SHA256:not-the-key" }), (error) => error?.code === "SSH_HOST_KEY_CHANGED");
});

test("ssh2 forward connection fails deterministically when the remote target never answers", async () => {
  class HangingForwardClient extends FakeClient {
    forwardOut() {}
  }
  const factory = new Ssh2TransportFactory({ ClientClass: HangingForwardClient, forwardConnectTimeoutMs: 10 });
  const session = await factory.connect(request);
  await assert.rejects(
    () => session.forwardOut({ destinationHost: "unreachable.internal", destinationPort: 443 }),
    (error) => error?.code === "SSH_FORWARD_TIMEOUT" && error?.retryable === true,
  );
  await session.close();
});

test("ssh2 session exposes a capability-scoped HTTP relay only through remote loopback and releases it", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  const factory = new Ssh2TransportFactory({ ClientClass: FakeClient });
  const session = await factory.connect(request);
  try {
    const proxy = await session.openLoopbackProxy({ bindingId: "binding-a", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "session-only-key" });
    assert.equal(proxy.host, "127.0.0.1");
    assert.equal(proxy.port, 41001);
    assert.equal(proxy.protocol, "http");
    assert.match(proxy.endpointPath, /^\/[A-Za-z0-9_-]{24,}\/v1$/);
    assert.equal(JSON.stringify(proxy).includes("session-only-key"), false);
    assert.deepEqual(session.client.reverseForwards, [{ host: "127.0.0.1", port: 0 }]);
    await proxy.close();
    assert.deepEqual(session.client.closedReverseForwards, [{ host: "127.0.0.1", port: 41001 }]);
  } finally {
    await session.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
