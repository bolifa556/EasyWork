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

test("host Agent API relay adapts unsupported effort once per route and reports both detected and cached rewrites", async () => {
  const observed = [];
  const adaptations = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const effort = body.reasoning_effort || body.reasoning?.effort || body.output_config?.effort || body.effort;
      observed.push({ url: request.url, effort, body });
      if (body.model === "asymmetric-model" && effort === "medium") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Unexpected reasoning effort medium. Supported types are xhigh (default) and low." } }));
        return;
      }
      if (effort === "high") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low." } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, effort }));
    });
  });
  const address = await listen(upstream);
  const relay = await createHostApiRelay({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "relay-adaptive-key",
    tokenFactory: () => "b".repeat(32),
    onEffortAdapted: (detail) => adaptations.push(detail),
  });
  try {
    const cases = [
      ["responses", { model: "same-model", reasoning: { effort: "high" } }],
      ["messages", { model: "same-model", output_config: { effort: "high" } }],
      ["chat/completions", { model: "same-model", reasoning_effort: "high" }],
    ];
    for (const [endpoint, body] of cases) {
      const response = await fetch(`http://${relay.host}:${relay.port}${relay.endpointPath}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, effort: "xhigh" });
    }
    assert.deepEqual(observed.map((entry) => [entry.url, entry.effort]), [
      ["/v1/responses", "high"], ["/v1/responses", "xhigh"],
      ["/v1/messages", "high"], ["/v1/messages", "xhigh"],
      ["/v1/chat/completions", "high"], ["/v1/chat/completions", "xhigh"],
    ]);
    assert.deepEqual(adaptations.map((entry) => [entry.endpoint, entry.requestedEffort, entry.appliedEffort, entry.cached]), [
      ["/v1/responses", "high", "xhigh", false],
      ["/v1/messages", "high", "xhigh", false],
      ["/v1/chat/completions", "high", "xhigh", false],
    ]);

    const cached = await fetch(`http://${relay.host}:${relay.port}${relay.endpointPath}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "same-model", reasoning: { effort: "high" } }),
    });
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), { ok: true, effort: "xhigh" });
    assert.deepEqual(observed.at(-1), {
      url: "/v1/responses",
      effort: "xhigh",
      body: { model: "same-model", reasoning: { effort: "xhigh" } },
    });
    assert.deepEqual(adaptations.at(-1), {
      requestedEffort: "high",
      appliedEffort: "xhigh",
      supportedEfforts: ["low", "medium", "xhigh"],
      model: "same-model",
      endpoint: "/v1/responses",
      cached: true,
    });

    const roundedUp = await fetch(`http://${relay.host}:${relay.port}${relay.endpointPath}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "asymmetric-model", reasoning: { effort: "medium" } }),
    });
    assert.equal(roundedUp.status, 200);
    assert.deepEqual(await roundedUp.json(), { ok: true, effort: "xhigh" });
    assert.deepEqual(observed.slice(-2).map((entry) => entry.effort), ["medium", "xhigh"]);
    assert.deepEqual(adaptations.at(-1), {
      requestedEffort: "medium",
      appliedEffort: "xhigh",
      supportedEfforts: ["low", "xhigh"],
      model: "asymmetric-model",
      endpoint: "/v1/responses",
      cached: false,
    });
  } finally {
    await relay.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
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
