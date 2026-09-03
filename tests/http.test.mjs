import assert from "node:assert/strict";
import test from "node:test";

import { HttpRouter, createApi } from "../gateway/core/index.mjs";

const actor = { actorType: "user", actorId: "user_a", deviceId: "device_a", sessionId: "session_a", roles: [] };
const auth = {
  async resolveSession(token) {
    if (token !== "valid-token") throw Object.assign(new Error("bad token"), { code: "SESSION_INVALID", status: 401 });
    return { actor, profile: { userId: "user_a", username: "alice" }, firstVisit: false };
  },
};

test("HTTP router authenticates before service resolution and returns the EasyWork envelope", async () => {
  let resolved = 0;
  const router = new HttpRouter({ auth, servicesForActor: async () => { resolved += 1; return { value: 42 }; } });
  router.route("GET", "/api/things/:id", ({ params, query, services }) => ({ id: params.id, query, value: services.value }));
  const unauthorized = await router.dispatch({ method: "GET", url: "/api/things/a" });
  assert.equal(unauthorized.status, 401);
  assert.equal(resolved, 0);
  const response = await router.dispatch({ method: "GET", url: "/api/things/a?q=x", headers: { authorization: "Bearer valid-token" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { id: "a", query: { q: "x" }, value: 42 });
  assert.match(response.body.meta.requestId, /^req_/);
});

test("专用 reveal 响应只允许登录路由并保持明文、no-store 与短期过期合同", async () => {
  const router = new HttpRouter({ auth, servicesForActor: async () => ({}) });
  assert.throws(
    () => router.route("POST", "/unsafe", () => ({}), { auth: false, secretResponse: true }),
    (error) => error?.code === "SECRET_RESPONSE_AUTH_REQUIRED",
  );
  router.route("POST", "/reveal", () => ({
    providerId: "provider_a",
    apiKey: "sk-http-reveal-secret-1234",
    expiresAt: "2026-08-10T08:00:30.000Z",
  }), { secretResponse: true });
  const response = await router.dispatch({ method: "POST", url: "/reveal", headers: { authorization: "Bearer valid-token" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.apiKey, "sk-http-reveal-secret-1234");
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.equal(response.headers.pragma, "no-cache");
});

test("Provider reveal API 只审计目标标识，不把 Key 写入普通响应路径或审计 metadata", async () => {
  const audited = [];
  const api = createApi({
    auth,
    servicesForActor: async () => ({
      providers: {
        async revealUserProvider(resolvedActor, providerId) {
          assert.equal(resolvedActor.actorId, actor.actorId);
          assert.equal(providerId, "provider_owned");
          return { providerId, apiKey: "sk-owned-http-secret-1234", expiresAt: "2026-08-10T08:00:30.000Z" };
        },
      },
      audit: { async append(event) { audited.push(event); } },
    }),
  });
  const response = await api.dispatch({
    method: "POST",
    url: "/api/providers/provider_owned/reveal",
    headers: { authorization: "Bearer valid-token", "x-request-id": "req-reveal-audit" },
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.apiKey, "sk-owned-http-secret-1234");
  assert.deepEqual(audited, [
    {
      action: "provider.key.revealed",
      target: { providerId: "provider_owned", scope: "actor" },
      requestId: "req-reveal-audit",
      metadata: { method: "POST" },
      status: "attempted",
    },
    {
      action: "provider.key.revealed",
      target: { providerId: "provider_owned", scope: "actor" },
      requestId: "req-reveal-audit",
      metadata: { method: "POST" },
      status: "success",
    },
  ]);
  assert.equal(JSON.stringify(audited).includes(response.body.data.apiKey), false);
});

test("EasyWork API keeps bootstrap summary-only and requires idempotency for a first message", async () => {
  const sent = [];
  const listed = [];
  const services = {
    conversations: {
      async listConversations(input) { listed.push(input); return { items: [{ id: "conv_a" }], nextCursor: "next" }; },
      async sendMessage(input) { sent.push(input); return { conversation: { id: input.conversationId } }; },
    },
    projects: { async list() { return []; } },
    servers: { async list() { return []; } },
    taskStore: { async listTasks() { return { items: [] }; } },
    providers: { async listAvailableProviders() { return []; } },
  };
  const api = createApi({ auth, servicesForActor: async () => services });
  const headers = { authorization: "Bearer valid-token" };
  const bootstrap = await api.dispatch({ method: "GET", url: "/api/bootstrap", headers });
  assert.deepEqual(Object.keys(bootstrap.body.data).sort(), ["actor", "conversationCursor", "device", "featureFlags", "projects", "providers", "recentConversations", "runningTasks", "servers"].sort());
  assert.deepEqual(listed[0], { limit: 8, projectId: null });
  const unassigned = await api.dispatch({ method: "GET", url: "/api/conversations?unassigned=true&limit=8", headers });
  assert.equal(unassigned.status, 200);
  assert.equal(listed[1].limit, 8);
  assert.equal(listed[1].projectId, null);
  const rejected = await api.dispatch({ method: "POST", url: "/api/conversations", headers, body: { mode: "chat", content: "hello", expectedRevision: 0 } });
  assert.equal(rejected.status, 428);
  const accepted = await api.dispatch({ method: "POST", url: "/api/conversations", headers: { ...headers, "idempotency-key": "send-1" }, body: { mode: "chat", content: "hello", expectedRevision: 0 } });
  assert.equal(accepted.status, 200);
  assert.equal(sent[0].commandId, "send-1");
});

test("Conversation connection can be disabled and restored without losing its server binding", async () => {
  let enabled = true;
  const services = {
    conversations: { async getConversation() { return { summary: { mode: "work" } }; } },
    servers: {
      async findConversationBinding(conversationId) { return { conversationId, serverId: "server_a" }; },
      async isConversationConnectionEnabled() { return enabled; },
      async bindConversation(serverId, conversationId) { assert.equal(serverId, "server_a"); assert.equal(conversationId, "conversation_a"); enabled = true; },
      async disableConversation(conversationId) { assert.equal(conversationId, "conversation_a"); enabled = false; return { conversationId, serverId: "server_a" }; },
    },
  };
  const api = createApi({ auth, servicesForActor: async () => services });
  const headers = { authorization: "Bearer valid-token" };
  const initial = await api.dispatch({ method: "GET", url: "/api/conversations/conversation_a/server-binding", headers });
  assert.deepEqual(initial.body.data, { conversationId: "conversation_a", serverId: "server_a", connectionEnabled: true });
  const disabled = await api.dispatch({ method: "DELETE", url: "/api/conversations/conversation_a/server-binding", headers, body: {} });
  assert.deepEqual(disabled.body.data, { conversationId: "conversation_a", serverId: "server_a", connectionEnabled: false });
  const restored = await api.dispatch({ method: "POST", url: "/api/conversations/conversation_a/server-binding", headers, body: { serverId: "server_a" } });
  assert.deepEqual(restored.body.data, { conversationId: "conversation_a", serverId: "server_a", connectionEnabled: true });
});

test("Conversation PATCH rejects mode changes before any metadata or server-binding mutation", async () => {
  let renamed = 0;
  let unbound = 0;
  const api = createApi({ auth, servicesForActor: async () => ({
    conversations: { async rename() { renamed += 1; return {}; } },
    servers: { async unbindConversationEverywhere() { unbound += 1; } },
  }) });
  const headers = { authorization: "Bearer valid-token", "idempotency-key": "immutable-mode" };
  for (const body of [{ mode: "chat" }, { mode: "work" }, { mode: "chat", title: "不能绕过" }]) {
    const result = await api.dispatch({ method: "PATCH", url: "/api/conversations/conversation_a", headers, body: { ...body, expectedRevision: 1 } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "CONVERSATION_MODE_FIXED");
  }
  assert.equal(renamed, 0);
  assert.equal(unbound, 0);
  const renamedResult = await api.dispatch({ method: "PATCH", url: "/api/conversations/conversation_a", headers, body: { title: "正常重命名", expectedRevision: 1 } });
  assert.equal(renamedResult.status, 200);
  assert.equal(renamed, 1);
});

test("Server list resolves bound conversation ids to readable titles", async () => {
  const services = {
    servers: {
      async list() {
        return [{ profile: { id: "server_a" }, conversationIds: ["conversation_a", "conversation_missing"] }];
      },
    },
    conversations: {
      async getConversationSummaries(conversationIds) {
        return conversationIds.includes("conversation_a") ? [{ id: "conversation_a", title: "部署生产环境" }] : [];
      },
    },
  };
  const api = createApi({ auth, servicesForActor: async () => services });
  const response = await api.dispatch({ method: "GET", url: "/api/servers", headers: { authorization: "Bearer valid-token" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data[0].conversations, [
    { id: "conversation_a", title: "部署生产环境" },
    { id: "conversation_missing", title: "未命名对话" },
  ]);
});

test("Profile PATCH cannot replace the authenticated Bearer token through its JSON body", async () => {
  let received = null;
  const profileAuth = {
    ...auth,
    async updateProfile(input) { received = input; return { username: input.username, revision: input.expectedRevision + 1 }; },
  };
  const api = createApi({ auth: profileAuth, servicesForActor: async () => ({}) });
  const headers = { authorization: "Bearer valid-token", "if-match": '"0"' };
  const rejected = await api.dispatch({ method: "PATCH", url: "/api/profile", headers, body: { username: "alice-2", token: "other-token" } });
  assert.equal(rejected.status, 400);
  assert.equal(received, null);
  const accepted = await api.dispatch({ method: "PATCH", url: "/api/profile", headers, body: { username: "alice-2" } });
  assert.equal(accepted.status, 200);
  assert.equal(received.token, "valid-token");
});
