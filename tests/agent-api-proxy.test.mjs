import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createHostApiRelay } from "../gateway/core/ssh/api-reverse-proxy.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

test("host Agent API relay injects the credential in memory, preserves streaming paths and releases its listener", async () => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      observed.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: one\n\n");
      response.end("data: two\n\n");
    });
  });
  const address = await listen(upstream);
  const apiKey = "relay-memory-only-key";
  const relay = await createHostApiRelay({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    tokenFactory: () => "a".repeat(32),
  });
  try {
    assert.equal(JSON.stringify(relay).includes(apiKey), false);
    const response = await fetch(`http://${relay.host}:${relay.port}${relay.endpointPath}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer remote-placeholder", "content-type": "application/json" },
      body: '{"stream":true}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: one\n\ndata: two\n\n");
    assert.equal(observed[0].url, "/v1/chat/completions");
    assert.equal(observed[0].headers.authorization, `Bearer ${apiKey}`);
    assert.equal(observed[0].headers["x-api-key"], apiKey);
    assert.equal(observed[0].body, '{"stream":true}');
    const forbidden = await fetch(`http://${relay.host}:${relay.port}/${"a".repeat(32)}/other`);
    assert.equal(forbidden.status, 403);
  } finally {
    await relay.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
  await assert.rejects(() => fetch(`http://${relay.host}:${relay.port}${relay.endpointPath}/models`));
});

test("host Agent API relay reports a typed upstream failure without exposing the credential", async () => {
  const reserved = http.createServer();
  const address = await listen(reserved);
  await new Promise((resolve) => reserved.close(resolve));
  const apiKey = "unreachable-memory-key";
  await assert.rejects(() => createHostApiRelay({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    connectTimeoutMs: 100,
  }), (error) => {
    assert.equal(error.code, "AGENT_API_UPSTREAM_UNREACHABLE");
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(apiKey), false);
    assert.equal(error.details.stage, "host_upstream_connect");
    return true;
  });
});
