import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import {
  OpenAICompatibleModelDetector,
  PLATFORM_PROVIDER_IDS,
  PlatformConfigurationService,
  ProviderSecretVault,
  ProviderService,
  ProviderUsageService,
} from "../gateway/core/platform/index.mjs";

const MASTER_SECRET = "platform-test-master-secret-with-at-least-32-characters";

function actor(id, roles = []) {
  return createActorContext({
    actorType: "user",
    actorId: id,
    deviceId: `device_${id}`,
    sessionId: `session_${id}`,
    roles,
  });
}

function guest(id = "guest_platform") {
  return createActorContext({
    actorType: "guest",
    actorId: id,
    deviceId: `device_${id}`,
    sessionId: `session_${id}`,
    roles: [],
  });
}

async function fixture(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-platform-"));
  try {
    return await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function services(dataRoot, overrides = {}) {
  const platform = new PlatformConfigurationService({
    dataRoot,
    masterSecret: MASTER_SECRET,
    clock: overrides.clock,
  });
  const providers = new ProviderService({
    dataRoot,
    masterSecret: MASTER_SECRET,
    platform,
    detector: overrides.detector,
    clock: overrides.clock,
    detectionCacheTtlMs: overrides.detectionCacheTtlMs,
  });
  return { platform, providers };
}

async function configurePlatformProvider(platform, admin, purpose, revision, commandId, apiKey = `sk-${purpose}-platform-secret`) {
  const patch = purpose === "embedding"
    ? {
        name: "平台向量",
        baseUrl: "https://models.example.test/v1/",
        protocol: "openai-embeddings",
        model: "qwen3-embedding",
        dimensions: 4096,
        chunkStrategy: "semantic",
        chunkSize: 2400,
        chunkOverlap: 240,
        batchSize: 24,
        hybridEnabled: true,
      }
    : purpose === "ocr"
      ? {
          name: "平台 OCR",
          baseUrl: "https://models.example.test/v1/",
          protocol: "chat-completions",
          model: "qwen-vl-ocr",
          maxOutputTokens: 6144,
        }
      : {
        name: purpose === "web" ? "网页公共模型" : "Agent 公共模型",
        baseUrl: "https://models.example.test/v1/",
        protocol: "auto",
      };
  return platform.updateProvider(admin, {
    purpose,
    patch,
    apiKey,
    expectedRevision: revision,
    commandId,
  });
}

test("平台配置只有管理员可查看和修改，默认四类 Provider 与 SSH 策略分属平台 scope", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_platform", ["admin"]);
    const ordinary = actor("user_platform");
    await assert.rejects(() => platform.inspect(ordinary), (error) => error?.code === "ROLE_REQUIRED");
    const snapshot = await platform.inspect(admin);
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(Object.keys(snapshot.providers), ["web", "agent", "embedding", "ocr"]);
    assert.equal(snapshot.providers.web.scope, "platform");
    assert.equal(snapshot.providers.agent.id, PLATFORM_PROVIDER_IDS.agent);
    assert.equal(snapshot.providers.embedding.embedding.model, "");
    assert.equal(snapshot.providers.ocr.ocr.model, "");
    assert.equal(snapshot.providers.ocr.protocol, "chat-completions");
    assert.equal(snapshot.ssh.idleTtlMinutes, 43_200);
  });
});

test("平台 API Key 使用 AES-GCM 落盘且所有公开结果仅返回 hasKey 和 maskedKey", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_secret", ["admin"]);
    const secret = "sk-super-sensitive-platform-key-987654";
    const updated = await configurePlatformProvider(platform, admin, "web", 0, "command-platform-web-0001", secret);
    assert.equal(updated.provider.configured, true);
    assert.equal(updated.provider.hasKey, true);
    assert.equal(updated.provider.maskedKey.endsWith("7654"), true);
    assert.equal(Object.hasOwn(updated.provider, "apiKey"), false);
    const disk = await readFile(path.join(dataRoot, "admins", "platform", "settings.json"), "utf8");
    assert.equal(disk.includes(secret), false);
    assert.match(disk, /"ciphertext"/);
    const publicProvider = await platform.publicProvider("web");
    assert.equal(JSON.stringify(publicProvider).includes(secret), false);
    const internal = await platform.resolveProvider("web");
    assert.equal(internal.credential.apiKey, secret);
  });
});

test("平台变更强制 expectedRevision，commandId 同请求可重放且不能换载荷复用", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_revision", ["admin"]);
    const input = {
      purpose: "web",
      patch: { name: "公共 API", baseUrl: "https://api.example.test/v1", protocol: "responses" },
      apiKey: "sk-revision-secret",
      expectedRevision: 0,
      commandId: "command-revision-0001",
    };
    const first = await platform.updateProvider(admin, input);
    assert.equal(first.revision, 1);
    assert.equal(first.replayed, false);
    const replay = await platform.updateProvider(admin, input);
    assert.equal(replay.revision, 1);
    assert.equal(replay.replayed, true);
    await assert.rejects(() => platform.updateProvider(admin, { ...input, patch: { ...input.patch, name: "另一配置" } }), (error) => error?.code === "COMMAND_ID_REUSED");
    await assert.rejects(() => platform.updateProvider(admin, { ...input, commandId: "command-revision-0002" }), (error) => error?.code === "REVISION_CONFLICT");
  });
});

test("Embedding 只有平台配置，保留模型和分块 profile；用户 Provider 协议拒绝 embedding", async () => {
  await fixture(async (dataRoot) => {
    const { platform, providers } = services(dataRoot);
    const admin = actor("admin_embedding", ["admin"]);
    const user = actor("user_embedding");
    const result = await configurePlatformProvider(platform, admin, "embedding", 0, "command-embedding-0001");
    assert.equal(result.provider.embedding.model, "qwen3-embedding");
    assert.equal(result.provider.embedding.chunkSize, 2400);
    assert.deepEqual(result.provider.embedding.memory, {
      enabled: true,
      vectorWeight: 0.55,
      lexicalWeight: 0.15,
      titleWeight: 0.3,
      minimumScore: 0.12,
      diversityLambda: 0.72,
      recallLimit: 48,
      resultLimit: 8,
      tokenBudget: 3200,
      pageSize: 20,
    });
    assert.match(result.provider.embeddingProfileId, /^emb_[a-f0-9]{24}$/);
    assert.match(result.provider.memoryEmbeddingProfileId, /^mem_emb_[a-f0-9]{24}$/);
    assert.match(result.provider.memoryRetrievalProfileId, /^mem_ret_[a-f0-9]{24}$/);
    assert.deepEqual((await providers.listAvailableProviders(user, "embedding")).map((entry) => entry.id), [PLATFORM_PROVIDER_IDS.embedding]);
    await assert.rejects(() => providers.createUserProvider(user, {
      provider: { name: "私有 Embedding", baseUrl: "https://private.example/v1", protocol: "openai-embeddings" },
      apiKey: "sk-private-embed",
      expectedRevision: 0,
      commandId: "command-user-embed-0001",
    }), (error) => error?.code === "PROVIDER_PROTOCOL_INVALID");
    await assert.rejects(() => providers.resolve(user, {
      providerId: "provider_private",
      purpose: "embedding",
      modelId: "qwen3-embedding",
      requireModel: true,
    }), (error) => error?.code === "EMBEDDING_PLATFORM_ONLY");
  });
});

test("文件分块和记忆检索配置独立保存，排序参数不会使文件向量 profile 失效", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_memory_retrieval", ["admin"]);
    const configured = await configurePlatformProvider(platform, admin, "embedding", 0, "command-embedding-memory-0001");
    const fileProfileId = configured.provider.embeddingProfileId;
    const memoryEmbeddingProfileId = configured.provider.memoryEmbeddingProfileId;
    const retrievalProfileId = configured.provider.memoryRetrievalProfileId;
    const updated = await platform.updateProvider(admin, {
      purpose: "embedding",
      patch: {
        memory: {
          enabled: true,
          vectorWeight: 0.6,
          lexicalWeight: 0.25,
          titleWeight: 0.15,
          minimumScore: 0.16,
          diversityLambda: 0.68,
          recallLimit: 64,
          resultLimit: 8,
          tokenBudget: 3600,
          pageSize: 24,
        },
      },
      expectedRevision: configured.revision,
      commandId: "command-embedding-memory-0002",
    });
    assert.equal(updated.provider.embedding.chunkSize, 2400);
    assert.equal(updated.provider.embedding.memory.recallLimit, 64);
    assert.equal(updated.provider.embedding.memory.minimumScore, 0.16);
    assert.equal(updated.provider.embedding.memory.diversityLambda, 0.68);
    assert.equal(updated.provider.embeddingProfileId, fileProfileId);
    assert.equal(updated.provider.memoryEmbeddingProfileId, memoryEmbeddingProfileId);
    assert.notEqual(updated.provider.memoryRetrievalProfileId, retrievalProfileId);
  });
});

test("OCR 只有管理员可配置，并保留视觉模型与输出限制", async () => {
  await fixture(async (dataRoot) => {
    const { platform, providers } = services(dataRoot);
    const admin = actor("admin_ocr", ["admin"]);
    const user = actor("user_ocr");
    const result = await configurePlatformProvider(platform, admin, "ocr", 0, "command-ocr-0001");
    assert.equal(result.provider.configured, true);
    assert.deepEqual(result.provider.ocr, { model: "qwen-vl-ocr", maxOutputTokens: 6144 });
    assert.deepEqual((await providers.listAvailableProviders(user, "ocr")).map((entry) => entry.id), [PLATFORM_PROVIDER_IDS.ocr]);
    await assert.rejects(() => providers.resolve(user, {
      providerId: "provider_private",
      purpose: "ocr",
      modelId: "qwen-vl-ocr",
      requireModel: true,
    }), (error) => error?.code === "OCR_PLATFORM_ONLY");
  });
});

test("OCR 可切换到 MinerU 文档解析协议，其他 Provider 不能误用", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_mineru", ["admin"]);
    const result = await platform.updateProvider(admin, {
      purpose: "ocr",
      patch: {
        name: "MinerU 文档解析",
        baseUrl: "https://api.example.test/",
        protocol: "mineru",
        model: "mineru",
        maxOutputTokens: 4096,
      },
      apiKey: "sk-mineru-platform-secret",
      expectedRevision: 0,
      commandId: "command-mineru-ocr-0001",
    });
    assert.equal(result.provider.protocol, "mineru");
    assert.equal(result.provider.baseUrl, "https://api.example.test");
    assert.equal((await platform.resolveProvider("ocr")).credential.protocol, "mineru");
    await assert.rejects(() => platform.updateProvider(admin, {
      purpose: "web",
      patch: { name: "错误协议", baseUrl: "https://api.example.test", protocol: "mineru" },
      expectedRevision: result.revision,
      commandId: "command-mineru-web-0001",
    }), (error) => error?.code === "PROVIDER_PROTOCOL_INVALID");
  });
});

test("同一用户可保存多个私有 API，Actor 间隔离且磁盘无明文", async () => {
  await fixture(async (dataRoot) => {
    const { providers } = services(dataRoot);
    const firstActor = actor("user_private_a");
    const secondActor = actor("user_private_b");
    const first = await providers.createUserProvider(firstActor, {
      provider: { name: "我的 Web API", baseUrl: "https://private-a.example/v1/", protocol: "chat-completions" },
      apiKey: "sk-private-user-a-web",
      expectedRevision: 0,
      commandId: "command-private-a-0001",
    });
    const second = await providers.createUserProvider(firstActor, {
      provider: { name: "我的 Agent API", baseUrl: "https://private-a.example/agent", protocol: "responses" },
      apiKey: "sk-private-user-a-agent",
      expectedRevision: first.revision,
      commandId: "command-private-a-0002",
    });
    assert.equal(second.revision, 2);
    const inspected = await providers.inspectUserProviders(firstActor);
    assert.equal(inspected.providers.length, 2);
    assert.equal(inspected.providers.every((entry) => entry.scope === "actor" && entry.actorId === firstActor.actorId), true);
    assert.equal(Object.hasOwn(inspected.providers[0], "apiKey"), false);
    assert.equal((await providers.inspectUserProviders(secondActor)).providers.length, 0);
    const disk = await readFile(path.join(dataRoot, "users", firstActor.actorId, "credentials", "providers.json"), "utf8");
    assert.equal(disk.includes("sk-private-user-a"), false);
    const revealed = await providers.revealUserProvider(firstActor, first.provider.id);
    assert.equal(revealed.apiKey, "sk-private-user-a-web");
    assert.equal(revealed.providerId, first.provider.id);
    assert.equal(Date.parse(revealed.expiresAt) > Date.now(), true);
    await assert.rejects(
      () => providers.revealUserProvider(secondActor, first.provider.id),
      (error) => error?.code === "PROVIDER_NOT_FOUND",
    );
    await assert.rejects(() => providers.updateUserProvider(secondActor, {
      providerId: first.provider.id,
      patch: { name: "越权" },
      expectedRevision: 0,
      commandId: "command-private-b-0001",
    }), (error) => error?.code === "PROVIDER_NOT_FOUND");
  });
});

test("用户 Provider CRUD 使用 revision 与 commandId，访客不能创建私有 API", async () => {
  await fixture(async (dataRoot) => {
    const { providers } = services(dataRoot);
    const user = actor("user_crud");
    const createdInput = {
      provider: { name: "可修改 API", baseUrl: "https://crud.example/v1", protocol: "auto" },
      apiKey: "sk-crud-secret",
      expectedRevision: 0,
      commandId: "command-crud-create-0001",
    };
    const created = await providers.createUserProvider(user, createdInput);
    const replay = await providers.createUserProvider(user, createdInput);
    assert.equal(replay.provider.id, created.provider.id);
    assert.equal(replay.replayed, true);
    const updated = await providers.updateUserProvider(user, {
      providerId: created.provider.id,
      patch: { name: "已修改 API" },
      clearApiKey: true,
      expectedRevision: created.revision,
      commandId: "command-crud-update-0001",
    });
    assert.equal(updated.provider.name, "已修改 API");
    assert.equal(updated.provider.configured, false);
    const deleted = await providers.deleteUserProvider(user, {
      providerId: created.provider.id,
      expectedRevision: updated.revision,
      commandId: "command-crud-delete-0001",
    });
    assert.equal(deleted.deletedProviderId, created.provider.id);
    assert.equal((await providers.inspectUserProviders(user)).providers.length, 0);
    await assert.rejects(() => providers.createUserProvider(guest(), createdInput), (error) => error?.code === "AUTHENTICATION_REQUIRED");
  });
});

test("有效 Provider 列表按用途合并平台与当前 Actor 私有配置，执行时模型由调用方选择", async () => {
  await fixture(async (dataRoot) => {
    const { platform, providers } = services(dataRoot);
    const admin = actor("admin_effective", ["admin"]);
    const user = actor("user_effective");
    await configurePlatformProvider(platform, admin, "web", 0, "command-effective-web-0001");
    const privateProvider = await providers.createUserProvider(user, {
      provider: { name: "个人 API", baseUrl: "https://agent-private.example/v1", protocol: "responses" },
      apiKey: "sk-effective-private",
      expectedRevision: 0,
      commandId: "command-effective-user-0001",
    });
    assert.deepEqual((await providers.listAvailableProviders(user, "web")).map((entry) => entry.id), [PLATFORM_PROVIDER_IDS.web, privateProvider.provider.id]);
    assert.deepEqual((await providers.listAvailableProviders(user, "agent")).map((entry) => entry.id), [privateProvider.provider.id]);
    await assert.rejects(() => providers.resolve(user, {
      providerId: privateProvider.provider.id,
      purpose: "agent",
      modelId: "",
      requireModel: true,
    }), (error) => error?.code === "PROVIDER_MODEL_REQUIRED");
    const resolved = await providers.resolve(user, {
      providerId: privateProvider.provider.id,
      purpose: "agent",
      modelId: "glm-5.2-107",
      requireModel: true,
    });
    assert.equal(resolved.model, "glm-5.2-107");
    assert.equal(resolved.credential.apiKey, "sk-effective-private");
  });
});

test("OpenAI-compatible 模型检测生成能力 descriptor，不在响应中泄露 Authorization", async () => {
  let request;
  const detector = new OpenAICompatibleModelDetector({
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "qwen3-embedding", owned_by: "lab", capabilities: { embeddings: true } },
            { id: "glm-5.2-107", context_window: 200000, supports_tools: true, supports_streaming: true },
            { id: "image-model" },
            { id: "mineru" },
            { id: "unlimited-ocr" },
          ],
        }),
      };
    },
  });
  const descriptors = await detector.detect({ baseUrl: "https://models.example/v1/", apiKey: "sk-detector-secret" });
  assert.equal(request.url, "https://models.example/v1/models");
  assert.equal(request.options.headers.authorization, "Bearer sk-detector-secret");
  assert.deepEqual(descriptors.find((entry) => entry.id === "qwen3-embedding").purposes, ["embedding"]);
  assert.equal(descriptors.find((entry) => entry.id === "glm-5.2-107").capabilities.toolCalling, true);
  assert.deepEqual(descriptors.find((entry) => entry.id === "image-model").purposes, []);
  assert.deepEqual(descriptors.find((entry) => entry.id === "mineru").purposes, []);
  assert.deepEqual(descriptors.find((entry) => entry.id === "unlimited-ocr").purposes, []);
  assert.equal(JSON.stringify(descriptors).includes("sk-detector-secret"), false);
});

test("OpenAI-compatible 模型检测允许只填写服务根地址，并仅在路由不存在时兼容 /models", async () => {
  const preferredRequests = [];
  const preferred = new OpenAICompatibleModelDetector({
    fetchImpl: async (url) => {
      preferredRequests.push(String(url));
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "root-model" }] }) };
    },
  });
  assert.deepEqual((await preferred.detect({ baseUrl: "http://211.86.151.186:8000", apiKey: "root-secret" })).map((model) => model.id), ["root-model"]);
  assert.deepEqual(preferredRequests, ["http://211.86.151.186:8000/v1/models"]);

  const fallbackRequests = [];
  const legacy = new OpenAICompatibleModelDetector({
    fetchImpl: async (url) => {
      fallbackRequests.push(String(url));
      if (String(url).endsWith("/v1/models")) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "legacy-model" }] }) };
    },
  });
  assert.deepEqual((await legacy.detect({ baseUrl: "https://legacy.example", apiKey: "legacy-secret" })).map((model) => model.id), ["legacy-model"]);
  assert.deepEqual(fallbackRequests, ["https://legacy.example/v1/models", "https://legacy.example/models"]);
});

test("OpenAI-compatible 模型检测有明确超时，不会让配置页无限等待", async () => {
  const detector = new OpenAICompatibleModelDetector({
    timeoutMs: 15,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    () => detector.detect({ baseUrl: "https://slow.example", apiKey: "slow-secret" }),
    (error) => error?.code === "PROVIDER_DETECTION_TIMEOUT",
  );
});

test("Provider 模型检测合并同一配置的并发读取并短时复用结果", async () => {
  await fixture(async (dataRoot) => {
    let calls = 0;
    const detector = {
      async detect() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ id: "cached-chat", purposes: ["web"], capabilities: {} }];
      },
    };
    const { platform, providers } = services(dataRoot, { detector, detectionCacheTtlMs: 60_000 });
    const admin = actor("admin_cached_detection", ["admin"]);
    const user = actor("user_cached_detection");
    await configurePlatformProvider(platform, admin, "web", 0, "command-cached-detect-web-0001");
    const request = { providerId: PLATFORM_PROVIDER_IDS.web, purpose: "web" };
    const [left, right] = await Promise.all([providers.detectModels(user, request), providers.detectModels(user, request)]);
    const third = await providers.detectModels(user, request);
    assert.equal(calls, 1);
    assert.deepEqual(left.models.map((model) => model.id), ["cached-chat"]);
    assert.deepEqual(right.models, left.models);
    assert.deepEqual(third.models, left.models);
  });
});

test("Provider 检测按用途过滤；Embedding 与 OCR 模型检测只允许管理员", async () => {
  await fixture(async (dataRoot) => {
    const detector = {
      detect: async () => [
        { id: "chat", name: "Chat", purposes: ["web", "agent"], capabilities: {} },
        { id: "embed", name: "Embed", purposes: ["embedding"], capabilities: {} },
        { id: "vision", name: "Vision", purposes: ["web", "agent", "ocr"], capabilities: { vision: true } },
      ],
    };
    const { platform, providers } = services(dataRoot, { detector });
    const admin = actor("admin_detect", ["admin"]);
    const user = actor("user_detect");
    const web = await configurePlatformProvider(platform, admin, "web", 0, "command-detect-web-0001");
    const embedding = await configurePlatformProvider(platform, admin, "embedding", web.revision, "command-detect-embed-0001");
    await configurePlatformProvider(platform, admin, "ocr", embedding.revision, "command-detect-ocr-0001");
    assert.deepEqual((await providers.detectModels(user, {
      providerId: PLATFORM_PROVIDER_IDS.web,
      purpose: "web",
    })).models.map((entry) => entry.id), ["chat", "vision"]);
    await assert.rejects(() => providers.detectModels(user, {
      providerId: PLATFORM_PROVIDER_IDS.embedding,
      purpose: "embedding",
    }), (error) => error?.code === "ROLE_REQUIRED");
    assert.deepEqual((await providers.detectModels(admin, {
      providerId: PLATFORM_PROVIDER_IDS.embedding,
      purpose: "embedding",
    })).models.map((entry) => entry.id), ["embed"]);
    assert.deepEqual((await providers.detectModelsFromDraft(admin, {
      purpose: "embedding",
      baseUrl: "https://draft-embedding.example/v1",
      apiKey: "sk-draft-embedding",
    })).models.map((entry) => entry.id), ["embed"]);
    await assert.rejects(() => providers.detectModels(user, {
      providerId: PLATFORM_PROVIDER_IDS.ocr,
      purpose: "ocr",
    }), (error) => error?.code === "ROLE_REQUIRED");
    assert.deepEqual((await providers.detectModels(admin, {
      providerId: PLATFORM_PROVIDER_IDS.ocr,
      purpose: "ocr",
    })).models.map((entry) => entry.id), ["vision"]);
    await assert.rejects(() => providers.detectModelsFromDraft(user, {
      purpose: "embedding",
      baseUrl: "https://draft-embedding.example/v1",
      apiKey: "sk-draft-embedding",
    }), (error) => error?.code === "ROLE_REQUIRED");
  });
});

test("SSH 管理参数版本化并输出 WorkerPool、NetworkPolicy、transport 和连接限额配置", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_ssh_policy", ["admin"]);
    const ordinary = actor("user_ssh_policy");
    const policy = {
      idleTtlMinutes: 1440,
      keepaliveIntervalSeconds: 45,
      keepaliveCountMax: 5,
      connectTimeoutSeconds: 18,
      maintenanceIntervalSeconds: 30,
      maxConnectionsPerUser: 4,
      maxTotalConnections: 40,
      allowedCidrs: ["10.0.0.0/8", "2001:db8::/32"],
      deniedCidrs: ["10.9.0.0/16"],
      allowedHosts: ["*.ustc.edu.cn"],
      deniedHosts: ["blocked.ustc.edu.cn"],
      allowedPorts: [2222, 22],
      deniedPorts: [23],
      allowPrivateKeyAuth: true,
      allowPasswordAuth: false,
    };
    await assert.rejects(() => platform.updateSshPolicy(ordinary, {
      policy,
      expectedRevision: 0,
      commandId: "command-ssh-policy-0000",
    }), (error) => error?.code === "ROLE_REQUIRED");
    const updated = await platform.updateSshPolicy(admin, {
      policy,
      expectedRevision: 0,
      commandId: "command-ssh-policy-0001",
    });
    assert.deepEqual(updated.ssh.allowedPorts, [22, 2222]);
    const runtime = await platform.sshRuntimeConfiguration();
    assert.deepEqual(runtime.workerPool, { keepAliveIntervalMs: 45_000, inactiveTtlMs: 86_400_000, maintenanceIntervalMs: 30_000 });
    assert.equal(runtime.transport.connectTimeoutMs, 18_000);
    assert.equal(runtime.transport.allowPasswordAuth, false);
    assert.deepEqual(runtime.networkPolicy.allowedHosts, ["*.ustc.edu.cn"]);
    assert.deepEqual(runtime.limits, { maxConnectionsPerUser: 4, maxTotalConnections: 40 });
    const replay = await platform.updateSshPolicy(admin, {
      policy,
      expectedRevision: 0,
      commandId: "command-ssh-policy-0001",
    });
    assert.equal(replay.replayed, true);
  });
});

test("SSH 策略拒绝非法 CIDR、端口、连接限额和完全禁用认证", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot);
    const admin = actor("admin_ssh_invalid", ["admin"]);
    const base = {
      idleTtlMinutes: 60,
      keepaliveIntervalSeconds: 30,
      keepaliveCountMax: 3,
      connectTimeoutSeconds: 10,
      maintenanceIntervalSeconds: 30,
      maxConnectionsPerUser: 2,
      maxTotalConnections: 10,
      allowedCidrs: [], deniedCidrs: [], allowedHosts: [], deniedHosts: [], allowedPorts: [], deniedPorts: [],
      allowPrivateKeyAuth: true, allowPasswordAuth: true,
    };
    await assert.rejects(() => platform.updateSshPolicy(admin, {
      policy: { ...base, allowedCidrs: ["10.0.0.0/99"] }, expectedRevision: 0, commandId: "command-ssh-invalid-001",
    }), (error) => error?.code === "SSH_CIDR_INVALID");
    await assert.rejects(() => platform.updateSshPolicy(admin, {
      policy: { ...base, maxConnectionsPerUser: 20, maxTotalConnections: 10 }, expectedRevision: 0, commandId: "command-ssh-invalid-002",
    }), (error) => error?.code === "SSH_CONNECTION_LIMIT_INVALID");
    await assert.rejects(() => platform.updateSshPolicy(admin, {
      policy: { ...base, allowPrivateKeyAuth: false, allowPasswordAuth: false }, expectedRevision: 0, commandId: "command-ssh-invalid-003",
    }), (error) => error?.code === "SSH_AUTH_POLICY_INVALID");
  });
});

test("用量只记录数值维度，按 actor/provider/purpose 聚合日、周、总量并对 commandId 幂等", async () => {
  await fixture(async (dataRoot) => {
    let current = new Date("2026-08-09T12:00:00.000Z");
    const clock = () => new Date(current);
    const { platform, providers } = services(dataRoot, { clock });
    const usage = new ProviderUsageService({ dataRoot, providerService: providers, clock });
    const admin = actor("admin_usage", ["admin"]);
    const firstUser = actor("user_usage_a");
    const secondUser = actor("user_usage_b");
    await configurePlatformProvider(platform, admin, "web", 0, "command-usage-web-0001");
    const first = await usage.record(firstUser, {
      providerId: PLATFORM_PROVIDER_IDS.web,
      purpose: "web",
      metrics: { requests: 1, inputTokens: 100, outputTokens: 20, latencyMs: 300 },
      commandId: "command-usage-record-0001",
    });
    assert.equal(first.recorded, true);
    const replay = await usage.record(firstUser, {
      providerId: PLATFORM_PROVIDER_IDS.web,
      purpose: "web",
      metrics: { requests: 1, inputTokens: 100, outputTokens: 20, latencyMs: 300 },
      commandId: "command-usage-record-0001",
    });
    assert.equal(replay.replayed, true);
    current = new Date("2026-08-10T12:00:00.000Z");
    await usage.record(secondUser, {
      providerId: PLATFORM_PROVIDER_IDS.web,
      purpose: "web",
      metrics: { requests: 2, inputTokens: 50, outputTokens: 10, errors: 1, latencyMs: 600 },
      commandId: "command-usage-record-0001",
    });
    const summary = await usage.summarize(admin);
    assert.deepEqual(summary.daily, { requests: 2, inputTokens: 50, outputTokens: 10, embeddingTokens: 0, errors: 1, latencyMs: 600 });
    assert.deepEqual(summary.total, { requests: 3, inputTokens: 150, outputTokens: 30, embeddingTokens: 0, errors: 1, latencyMs: 900 });
    assert.equal(summary.byProvider[PLATFORM_PROVIDER_IDS.web].requests, 3);
    assert.equal(summary.byPurpose.web.inputTokens, 150);
    assert.equal(summary.byActor[`user:${firstUser.actorId}`].requests, 1);
    assert.equal(summary.series.length, 14);
    assert.equal(summary.series.at(-1).date, "2026-08-10");
    assert.equal(summary.series.at(-1).requests, 2);
    assert.equal(summary.series.at(-2).requests, 1);
    const filtered = await usage.summarize(admin, { actorType: "user", actorId: firstUser.actorId });
    assert.equal(filtered.total.requests, 1);
    await assert.rejects(() => usage.summarize(firstUser), (error) => error?.code === "ROLE_REQUIRED");
  });
});

test("用量接口拒绝 prompt 等非数值字段，磁盘只含聚合 metadata", async () => {
  await fixture(async (dataRoot) => {
    const { platform, providers } = services(dataRoot);
    const usage = new ProviderUsageService({ dataRoot, providerService: providers });
    const admin = actor("admin_usage_schema", ["admin"]);
    const user = actor("user_usage_schema");
    await configurePlatformProvider(platform, admin, "web", 0, "command-usage-schema-web");
    await assert.rejects(() => usage.record(user, {
      providerId: PLATFORM_PROVIDER_IDS.web,
      purpose: "web",
      metrics: { requests: 1, prompt: "绝不能落盘的用户原文" },
      commandId: "command-usage-schema-record",
    }), (error) => error?.code === "PLATFORM_INPUT_SCHEMA_INVALID");
    const usageRoot = path.join(dataRoot, "admins", "platform", "usage");
    assert.deepEqual(await readdir(usageRoot).catch(() => []), []);
  });
});

test("Vault AAD 绑定平台或 Actor scope，同一密文不能由另一 scope 解密", () => {
  const first = new ProviderSecretVault({ masterSecret: MASTER_SECRET, scope: "user:first" });
  const second = new ProviderSecretVault({ masterSecret: MASTER_SECRET, scope: "user:second" });
  const sealed = first.seal("sk-isolated-secret", "provider_isolated");
  assert.equal(first.open(sealed, "provider_isolated"), "sk-isolated-secret");
  assert.throws(() => second.open(sealed, "provider_isolated"), (error) => error?.code === "PROVIDER_SECRET_DECRYPT_FAILED");
  assert.throws(() => first.open(sealed, "provider_other"), (error) => error?.code === "PROVIDER_SECRET_DECRYPT_FAILED");
});

test("平台 Key 只能由管理员短时 reveal，普通用户不能读取", async () => {
  await fixture(async (dataRoot) => {
    const { platform } = services(dataRoot, { clock: () => new Date("2026-08-10T08:00:00.000Z") });
    const admin = actor("admin_reveal", ["admin"]);
    const ordinary = actor("user_reveal");
    await configurePlatformProvider(platform, admin, "agent", 0, "command-platform-reveal", "sk-platform-reveal-secret");
    await assert.rejects(() => platform.revealProvider(ordinary, "agent"), (error) => error?.code === "ROLE_REQUIRED");
    const revealed = await platform.revealProvider(admin, "agent");
    assert.deepEqual(revealed, {
      providerId: PLATFORM_PROVIDER_IDS.agent,
      apiKey: "sk-platform-reveal-secret",
      expiresAt: "2026-08-10T08:00:30.000Z",
    });
    const publicSnapshot = await platform.inspect(admin);
    assert.equal(JSON.stringify(publicSnapshot).includes(revealed.apiKey), false);
    const disk = await readFile(path.join(dataRoot, "admins", "platform", "settings.json"), "utf8");
    assert.equal(disk.includes(revealed.apiKey), false);
  });
});

test("模型检测网络与响应失败返回稳定错误且不回显密钥", async () => {
  const unreachable = new OpenAICompatibleModelDetector({ fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(() => unreachable.detect({ baseUrl: "https://offline.example/v1", apiKey: "sk-never-echo-this" }), (error) => (
    error?.code === "PROVIDER_DETECTION_UNREACHABLE" && !JSON.stringify(error).includes("sk-never-echo-this")
  ));
  const invalid = new OpenAICompatibleModelDetector({ fetchImpl: async () => ({ ok: true, json: async () => ({ unexpected: [] }) }) });
  await assert.rejects(() => invalid.detect({ baseUrl: "https://invalid.example/v1", apiKey: "sk-invalid-response" }), (error) => error?.code === "PROVIDER_DETECTION_INVALID_RESPONSE");
  const unauthorized = new OpenAICompatibleModelDetector({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(() => unauthorized.detect({ baseUrl: "https://unauthorized.example", apiKey: "wrong-key" }), (error) => (
    error?.code === "PROVIDER_DETECTION_FAILED" && error?.expose === true && /API Key/.test(error.message)
  ));
});
