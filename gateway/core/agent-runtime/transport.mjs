import crypto from "node:crypto";

import { ApiError, invariant } from "../errors.mjs";
import {
  assertEasyWorkSkillPaths,
  createRuntimeRunId,
  remoteAgentPaths,
  runtimeAgentDefinition,
  runtimeEnvironment,
  unsupportedCapability,
} from "./contract.mjs";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function frameFromLine(line, { sse = false } = {}) {
  let text = String(line || "").trim();
  if (!text || text.startsWith(":")) return null;
  if (sse) {
    if (!text.startsWith("data:")) return null;
    text = text.slice(5).trim();
    if (!text || text === "[DONE]") return null;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function* parsedFrames(lines, options = {}) {
  for await (const line of lines) {
    const frame = frameFromLine(line, options);
    if (frame) yield frame;
  }
}

function openCodeFrameSessionId(frame) {
  const properties = frame && typeof frame === "object" && !Array.isArray(frame)
    ? (frame.properties && typeof frame.properties === "object" ? frame.properties : frame.data)
    : null;
  const info = properties?.info || properties?.message;
  const part = properties?.part;
  return String(
    properties?.sessionID
      || properties?.sessionId
      || info?.sessionID
      || info?.sessionId
      || part?.sessionID
      || part?.sessionId
      || "",
  );
}

function openCodeMessageId(message) {
  return String(message?.info?.id || message?.id || "");
}

function openCodePartId(part) {
  return String(part?.id || "");
}

function stableFingerprint(value) {
  try { return JSON.stringify(value); } catch { return ""; }
}

function completedOpenCodeTurn(messages, baselineMessageIds) {
  const created = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      const info = message?.info || {};
      return info.role === "assistant" && !baselineMessageIds.has(openCodeMessageId(message));
    })
    .sort((left, right) => Number(left?.info?.time?.created || 0) - Number(right?.info?.time?.created || 0));
  const finalMessage = [...created].reverse().find((message) => {
    const finish = String(message?.info?.finish || "").toLowerCase();
    return Boolean(message?.info?.time?.completed) && finish && finish !== "tool-calls";
  });
  return finalMessage ? created : [];
}

async function openCodeMessages(executor, port, sessionId) {
  const result = await executor.requestHttp({
    host: "127.0.0.1",
    port,
    method: "GET",
    path: `/session/${encodeURIComponent(sessionId)}/message`,
  });
  return Array.isArray(result) ? result : [];
}

async function* resilientOpenCodeFrames({ lines, executor, port, sessionId, baselineMessageIds, pollIntervalMs }) {
  const iterator = lines[Symbol.asyncIterator]();
  const observedMessages = new Map();
  const observedParts = new Map();
  let busySeen = false;
  let pending = iterator.next().then(
    (result) => ({ type: "line", result }),
    (error) => ({ type: "error", error }),
  );

  const replayCompletedTurn = async function* () {
    const messages = await openCodeMessages(executor, port, sessionId);
    const completed = completedOpenCodeTurn(messages, baselineMessageIds);
    if (!completed.length) return false;
    for (const message of completed) {
      const info = message?.info || {};
      const messageId = openCodeMessageId(message);
      const infoFingerprint = stableFingerprint(info);
      if (messageId && observedMessages.get(messageId) !== infoFingerprint) {
        observedMessages.set(messageId, infoFingerprint);
        yield { type: "message.updated", properties: { info } };
      }
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        const partId = openCodePartId(part);
        const partFingerprint = stableFingerprint(part);
        if (partId && observedParts.get(partId) === partFingerprint) continue;
        if (partId) observedParts.set(partId, partFingerprint);
        yield { type: "message.part.updated", properties: { part } };
      }
    }
    return true;
  };

  try {
    while (true) {
      const next = await Promise.race([
        pending,
        sleep(pollIntervalMs).then(() => ({ type: "poll" })),
      ]);
      if (next.type === "error") throw next.error;
      if (next.type === "line") {
        if (next.result.done) break;
        pending = iterator.next().then(
          (result) => ({ type: "line", result }),
          (error) => ({ type: "error", error }),
        );
        const frame = frameFromLine(next.result.value, { sse: true });
        if (!frame) continue;
        const frameSessionId = openCodeFrameSessionId(frame);
        if (frameSessionId && frameSessionId !== sessionId) continue;
        const properties = frame.properties || frame.data || {};
        const info = properties.info || properties.message;
        const part = properties.part;
        if (info?.id) observedMessages.set(String(info.id), stableFingerprint(info));
        if (part?.id) observedParts.set(String(part.id), stableFingerprint(part));
        if (frame.type === "session.status") {
          const status = String(properties.status?.type || properties.status || "").toLowerCase();
          if (["busy", "running", "working", "pending"].includes(status)) busySeen = true;
        }
        if (frame.type === "session.idle") {
          for await (const recovered of replayCompletedTurn()) yield recovered;
          yield frame;
          return;
        }
        yield frame;
        continue;
      }

      let snapshot;
      try {
        snapshot = await executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/session/status" });
      } catch {
        continue;
      }
      if (openCodeSessionIsBusy(snapshot, sessionId)) {
        busySeen = true;
        continue;
      }
      if (!busySeen) continue;
      let recovered = false;
      try {
        for await (const frame of replayCompletedTurn()) {
          recovered = true;
          yield frame;
        }
      } catch {
        continue;
      }
      if (recovered) {
        yield { type: "session.idle", properties: { sessionID: sessionId } };
        return;
      }
    }
  } finally {
    await iterator.return?.();
  }
}

function deepSubstitute(value, variables) {
  if (typeof value === "string") {
    if (variables[value] !== undefined) return variables[value];
    return Object.entries(variables).reduce(
      (resolved, [placeholder, replacement]) => resolved.split(placeholder).join(String(replacement)),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => deepSubstitute(entry, variables));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepSubstitute(entry, variables)]));
}

function nativeRunId(binding) {
  return binding?.activeRunId || null;
}

function activeEntryKey(binding) {
  return String(binding.agentBindingId);
}

function servicePort(bindingId) {
  const digest = crypto.createHash("sha256").update(String(bindingId)).digest();
  return 24_000 + digest.readUInt16BE(0) % 16_000;
}

function statusCode(error) {
  return Number(error?.status || 0);
}

function openCodeSessionIsBusy(snapshot, sessionId) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const entry = snapshot[sessionId];
  if (!entry) return false;
  const status = String(
    typeof entry === "string"
      ? entry
      : entry.type || entry.status?.type || entry.status || entry.state || "",
  ).trim().toLowerCase();
  return ["busy", "running", "working", "pending"].includes(status);
}

function openCodeRequestSessionId(request) {
  const match = String(request?.path || "").match(/^\/session\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : "";
}

function normalizedApiRoute(value) {
  if (!value) return null;
  invariant(value && typeof value === "object" && !Array.isArray(value), "AGENT_API_ROUTE_INVALID", "Agent API route 无效", { status: 500, expose: false });
  let parsed;
  try { parsed = new URL(String(value.baseUrl || "")); } catch { /* handled below */ }
  invariant(parsed && ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash, "AGENT_API_ROUTE_INVALID", "Agent API route 无效", { status: 500, expose: false });
  const apiKey = String(value.apiKey || "");
  invariant(apiKey, "AGENT_API_ROUTE_CREDENTIAL_MISSING", "Agent API route 缺少 credential", { status: 409 });
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.search = "";
  return Object.freeze({
    baseUrl: parsed.toString().replace(/\/$/, ""),
    apiKey,
    model: String(value.model || ""),
    providerId: String(value.providerId || ""),
    protocol: String(value.protocol || "auto"),
    remoteReachable: typeof value.remoteReachable === "boolean" ? value.remoteReachable : null,
    targetHost: parsed.hostname,
    targetPort: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
  });
}

function apiEnvironment(endpoint, apiKey) {
  return {
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_BASE: endpoint,
    OPENAI_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
}

function managedRuntimeFingerprint(agentId, configuration, route) {
  // Bump this whenever the generated runtime configuration changes shape.
  // A managed Agent process must never keep serving with a configuration that
  // was generated by an older contract merely because its model/API values
  // happen to be identical.
  const configurationContract = "2026-08-12.1";
  const credentialDigest = route?.apiKey
    ? crypto.createHash("sha256").update(route.apiKey).digest("hex")
    : null;
  return crypto.createHash("sha256").update(JSON.stringify({
    agentId,
    configurationContract,
    configuration,
    route: route ? {
      baseUrl: route.baseUrl,
      model: route.model,
      protocol: route.protocol,
      credentialDigest,
    } : null,
  })).digest("hex");
}

export class AgentRuntimeTransport {
  constructor({ executor, deploymentService, skillDeployment = null, configurationService = null, clock = () => Date.now(), httpReadyAttempts = 30, httpReadyDelayMs = 100, openCodePollIntervalMs = 500 } = {}) {
    invariant(executor && typeof executor.spawn === "function" && typeof executor.exec === "function", "AGENT_RUNTIME_EXECUTOR_REQUIRED", "缺少 Agent runtime executor", {
      status: 500,
      expose: false,
    });
    invariant(deploymentService && typeof deploymentService.resolveRuntime === "function", "AGENT_DEPLOYMENT_SERVICE_REQUIRED", "缺少 Agent deployment service", {
      status: 500,
      expose: false,
    });
    this.executor = executor;
    this.deploymentService = deploymentService;
    this.skillDeployment = skillDeployment;
    this.configurationService = configurationService;
    this.clock = clock;
    this.httpReadyAttempts = httpReadyAttempts;
    this.httpReadyDelayMs = httpReadyDelayMs;
    this.openCodePollIntervalMs = openCodePollIntervalMs;
    this.active = new Map();
    this.proxies = new Map();
  }

  async execute(request) {
    invariant(request && request.descriptor && request.binding, "AGENT_TRANSPORT_REQUEST_INVALID", "Agent transport 请求不完整", { status: 400 });
    const agentId = String(request.adapterId || "");
    runtimeAgentDefinition(agentId);
    invariant(request.descriptor.adapter === agentId && request.descriptor.operation === request.operation, "AGENT_TRANSPORT_DESCRIPTOR_MISMATCH", "Agent operation descriptor 与请求不一致", {
      status: 400,
    });
    const bindingId = String(request.binding.agentBindingId || "");
    const installation = await this.deploymentService.resolveRuntime(agentId, {
      source: request.agentSource || request.binding.native?.agentSource || null,
    });
    const home = await this.executor.home();
    const paths = remoteAgentPaths(home, agentId, bindingId);
    const deployedSkills = request.skills && !Array.isArray(request.skills)
      ? await this.#deploySkills(request.skills)
      : (request.skills || []);
    const skills = assertEasyWorkSkillPaths(deployedSkills, paths.skillsRoot);
    const apiRoute = installation.source === "managed" ? normalizedApiRoute(request.apiRoute) : null;
    const storedConfiguration = installation.source === "managed" && this.configurationService
      ? await this.configurationService.runtimeValues(agentId)
      : {};
    const configuration = apiRoute?.model && !storedConfiguration.model
      ? { ...storedConfiguration, model: apiRoute.model }
      : storedConfiguration;
    await this.#prepareRuntime(paths);
    const environment = request.descriptor.transport === "event-cache"
      ? (installation.source === "managed" ? runtimeEnvironment(paths) : Object.freeze({ EASYWORK_SKILLS_DIR: paths.skillsRoot }))
      : await this.#runtimeEnvironment(request, paths, installation, configuration, apiRoute);
    const runtimeApiRoute = apiRoute
      ? { ...apiRoute, baseUrl: environment.OPENAI_BASE_URL || apiRoute.baseUrl }
      : null;
    if (installation.source === "managed") await this.#applyManagedConfiguration(agentId, paths, configuration, runtimeApiRoute);
    const runtimeFingerprint = installation.source === "managed"
      ? managedRuntimeFingerprint(agentId, configuration, runtimeApiRoute)
      : null;
    const context = { request, agentId, bindingId, installation, paths, skills, environment, configuration, apiRoute, runtimeFingerprint };

    if (request.descriptor.transport === "event-cache") {
      return {
        runId: nativeRunId(request.binding),
        bindingPatch: {
          native: {
            agentSource: installation.source,
            binaryPath: installation.binaryPath,
            runtimeRoot: paths.runtimeRoot,
          },
        },
        contextUsage: request.binding.state?.contextUsage || null,
      };
    }
    if (agentId === "opencode") return this.#executeOpenCode(context);
    if (agentId === "codex") return this.#executeCodex(context);
    if (agentId === "claude-code") return this.#executeClaudeCode(context);
    return unsupportedCapability(agentId, request.operation, "no_transport");
  }

  async close() {
    const processes = [...this.active.values()].map((entry) => entry?.process).filter((process) => process && !process.closed);
    this.active.clear();
    await Promise.allSettled(processes.map(async (process) => {
      if (typeof process.signal === "function") await process.signal("SIGTERM");
    }));
    await Promise.allSettled([...this.proxies.keys()].map((bindingId) => this.#releaseProxy(bindingId)));
  }

  async #deploySkills(plan) {
    invariant(this.skillDeployment && typeof this.skillDeployment.ensure === "function", "AGENT_SKILL_DEPLOYMENT_UNAVAILABLE", "远端 Skill 部署能力不可用", { status: 503, retryable: true });
    return this.skillDeployment.ensure(plan);
  }

  async #prepareRuntime(paths) {
    const directories = [
      paths.runtimeRoot,
      paths.runtimeHome,
      paths.runtimeConfig,
      paths.runtimeData,
      paths.runtimeCache,
      paths.runtimeState,
      paths.runtimeLogs,
      paths.skillsRoot,
      paths.runtimeReleases,
    ];
    const guarded = [...new Set([
      paths.easyworkRoot,
      `${paths.easyworkRoot}/runtime`,
      `${paths.easyworkRoot}/runtime/agents`,
      paths.agentRuntimeRoot,
      paths.skillsRoot,
      ...directories,
    ])];
    const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
    const result = await this.executor.exec(`for target in ${guarded.map(quote).join(" ")}; do [ ! -L "$target" ] || exit 73; done; mkdir -p ${directories.map(quote).join(" ")}; chmod 0700 ${quote(paths.easyworkRoot)} ${quote(paths.runtimeRoot)}`);
    invariant(result.code === 0, "AGENT_RUNTIME_PREPARE_FAILED", "无法创建远端 Agent runtime", { status: 502 });
    const skillViews = [
      `${paths.runtimeData}/codex/skills`,
      `${paths.runtimeData}/claude/skills`,
      `${paths.runtimeConfig}/opencode/skills`,
    ];
    const parents = skillViews.map((entry) => entry.slice(0, entry.lastIndexOf("/")));
    const linkResult = await this.executor.exec(
      `mkdir -p ${parents.map((directory) => `'${directory.replace(/'/g, `'"'"'`)}'`).join(" ")} && ${skillViews.map((entry) => `ln -sfn '${paths.skillsRoot.replace(/'/g, `'"'"'`)}' '${entry.replace(/'/g, `'"'"'`)}'`).join(" && ")}`,
    );
    invariant(linkResult.code === 0, "AGENT_SKILL_VIEW_FAILED", "无法建立隔离的 Agent Skill 视图", { status: 502 });
  }

  async #runtimeEnvironment(request, paths, installation, configuration = {}, route = null) {
    const extra = {};
    if (installation.source === "managed" && route) {
      const remoteReachable = route.remoteReachable === null
        ? (typeof this.executor.probeTcp === "function" && await this.executor.probeTcp({ host: route.targetHost, port: route.targetPort }))
        : route.remoteReachable;
      let endpoint = route.baseUrl;
      let runtimeKey = route.apiKey;
      if (!remoteReachable) {
      let proxy;
      try {
          proxy = await this.#proxyFor(request.binding.agentBindingId, route);
      } catch (error) {
        if (error?.code === "AGENT_API_UPSTREAM_UNREACHABLE") throw error;
        throw new ApiError("AGENT_API_PROXY_UNAVAILABLE", "远端无法访问模型 API，SSH loopback proxy 建立失败", {
          status: statusCode(error) || 502,
          details: { reason: String(error?.code || "proxy_failed") },
          cause: error,
        });
      }
        endpoint = `${proxy.protocol}://${proxy.host}:${proxy.port}${proxy.endpointPath}`;
        runtimeKey = "easywork-proxy";
        request.__runtimeProxy = { mode: "ssh-reverse", protocol: proxy.protocol };
      } else {
        await this.#releaseProxy(request.binding.agentBindingId);
        request.__runtimeProxy = { mode: "direct", protocol: new URL(route.baseUrl).protocol.replace(":", "") };
      }
      Object.assign(extra, apiEnvironment(endpoint, runtimeKey));
    }
    if (installation.source === "managed") {
      if (configuration.effortLevel) extra.CLAUDE_CODE_EFFORT_LEVEL = configuration.effortLevel;
      return runtimeEnvironment(paths, extra);
    }
    return Object.freeze({ EASYWORK_SKILLS_DIR: paths.skillsRoot, ...extra });
  }

  async #proxyFor(bindingId, route) {
    const key = String(bindingId);
    const fingerprint = crypto.createHash("sha256").update(route.baseUrl).update("\0").update(route.apiKey).digest("hex");
    const existing = this.proxies.get(key);
    if (existing?.fingerprint === fingerprint && existing.handle?.isClosed?.() !== true) return existing.handle;
    if (existing) await this.#releaseProxy(key);
    const handle = await this.executor.openLoopbackProxy({ bindingId: key, baseUrl: route.baseUrl, apiKey: route.apiKey });
    this.proxies.set(key, { fingerprint, handle });
    return handle;
  }

  async #releaseProxy(bindingId) {
    const key = String(bindingId);
    const entry = this.proxies.get(key);
    if (!entry) return;
    this.proxies.delete(key);
    await entry.handle?.close?.();
  }

  async #applyManagedConfiguration(agentId, paths, configuration, apiRoute = null) {
    if (agentId === "opencode") {
      const model = String(apiRoute?.model || configuration.model || "").trim();
      const skillPermission = { [`${paths.skillsRoot}/**`]: "allow" };
      const content = {
        "$schema": "https://opencode.ai/config.json",
        ...(model && apiRoute ? {
          model: `easywork/${model}`,
          provider: {
            easywork: {
              npm: "@ai-sdk/openai-compatible",
              name: "EasyWork",
              options: {
                baseURL: "{env:OPENAI_BASE_URL}",
                apiKey: "{env:OPENAI_API_KEY}",
              },
              models: {
                [model]: { name: model },
              },
            },
          },
        } : model ? { model } : {}),
        permission: {
          ...(configuration.permissionMode ? { "*": configuration.permissionMode } : {}),
          external_directory: skillPermission,
        },
      };
      await this.executor.writeAtomic(`${paths.runtimeConfig}/opencode/opencode.json`, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
      return;
    }
    if (agentId === "codex") {
      const model = String(apiRoute?.model || configuration.model || "").trim();
      const pairs = [
        ["model", model],
        ["model_provider", apiRoute ? "easywork" : null],
        ["model_reasoning_effort", configuration.reasoningEffort],
        ["approval_policy", configuration.approvalPolicy],
        ["sandbox_mode", configuration.sandboxMode],
      ].filter(([, value]) => value);
      const provider = apiRoute ? [
        "",
        "[model_providers.easywork]",
        `name = ${JSON.stringify("EasyWork")}`,
        `base_url = ${JSON.stringify(apiRoute.baseUrl)}`,
        `env_key = ${JSON.stringify("OPENAI_API_KEY")}`,
        `wire_api = ${JSON.stringify("responses")}`,
        "requires_openai_auth = false",
        "supports_websockets = false",
      ] : [];
      await this.executor.writeAtomic(`${paths.runtimeData}/codex/config.toml`, `${[
        ...pairs.map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        ...provider,
      ].join("\n")}\n`, { mode: 0o600 });
      return;
    }
    if (agentId === "claude-code") {
      const settings = {
        ...(configuration.effortLevel && configuration.effortLevel !== "auto" ? { effortLevel: configuration.effortLevel } : {}),
        ...(configuration.permissionMode ? { permissions: { defaultMode: configuration.permissionMode } } : {}),
      };
      await this.executor.writeAtomic(`${paths.runtimeData}/claude/settings.json`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    }
  }

  async #recordRuntime(context, details) {
    const state = {
      schemaVersion: 1,
      agentId: context.agentId,
      agentBindingId: context.bindingId,
      source: context.installation.source,
      managed: context.installation.source === "managed",
      version: context.installation.version,
      binaryPath: context.installation.binaryPath,
      updatedAt: new Date(this.clock()).toISOString(),
      ...details,
    };
    await this.executor.writeAtomic(`${context.paths.runtimeState}/active.json`, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #waitForHttp(port) {
    let lastError = null;
    for (let attempt = 0; attempt < this.httpReadyAttempts; attempt += 1) {
      try {
        await this.executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/global/health" });
        return;
      } catch (error) {
        lastError = error;
        await sleep(this.httpReadyDelayMs);
      }
    }
    throw new ApiError("AGENT_SERVICE_START_FAILED", "OpenCode loopback 服务未就绪", {
      status: 502,
      details: { reason: String(lastError?.code || "health_timeout") },
      cause: lastError,
    });
  }

  async #openCodeService(context) {
    const key = activeEntryKey(context.request.binding);
    let entry = this.active.get(key);
    const rememberedPort = Number(context.request.binding.native?.servicePort);
    const rememberedFingerprint = String(context.request.binding.native?.runtimeFingerprint || "");
    const refreshConfiguration = ["start", "resume"].includes(context.request.operation)
      && context.runtimeFingerprint
      && context.runtimeFingerprint !== String(entry?.runtimeFingerprint || rememberedFingerprint);
    if (refreshConfiguration && Number.isSafeInteger(entry?.servicePort || rememberedPort)) {
      await this.#stopOpenCodeService(context, entry?.servicePort || rememberedPort, entry);
      entry = null;
    }
    if (entry?.agentId === "opencode" && entry.process && !entry.process.closed) return entry;
    if (!entry && Number.isSafeInteger(rememberedPort)) {
      try {
        await this.executor.requestHttp({ host: "127.0.0.1", port: rememberedPort, method: "GET", path: "/global/health" });
        entry = { agentId: "opencode", process: null, servicePort: rememberedPort, runtimeFingerprint: rememberedFingerprint || null };
        this.active.set(key, entry);
        return entry;
      } catch {
        // The remembered process is gone; create a new isolated service.
      }
    }
    const port = servicePort(context.bindingId);
    try {
      await this.executor.requestHttp({ host: "127.0.0.1", port, method: "GET", path: "/global/health" });
      entry = { agentId: "opencode", process: null, servicePort: port, runtimeFingerprint: context.runtimeFingerprint };
      this.active.set(key, entry);
      return entry;
    } catch {
      // No reusable deterministic service exists for this binding.
    }
    const specification = {
      executable: context.installation.binaryPath,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: context.request.workspace?.path || context.request.descriptor.cwd || context.paths.runtimeHome,
      env: context.environment,
      logPath: `${context.paths.runtimeLogs}/opencode-serve.log`,
    };
    // OpenCode is controlled through its loopback HTTP/SSE service. Detaching
    // it frees the SSH exec channel before opening the forwarding channels;
    // some HPC/managed SSH servers allow only one concurrent channel per
    // connection, which otherwise deadlocks immediately after a successful
    // spawn.
    const process = typeof this.executor.spawnDetached === "function"
      ? await this.executor.spawnDetached(specification)
      : await this.executor.spawn(specification);
    entry = { agentId: "opencode", process, servicePort: port, runtimeFingerprint: context.runtimeFingerprint };
    this.active.set(key, entry);
    if (!process.detached) process.wait?.().finally(() => {
      if (this.active.get(key)?.process === process) this.active.delete(key);
      void this.#releaseProxy(context.bindingId);
    }).catch(() => {});
    await this.#waitForHttp(port);
    return entry;
  }

  async #stopOpenCodeService(context, port, entry) {
    if (entry?.process && !entry.process.closed && typeof entry.process.signal === "function") {
      await entry.process.signal("SIGTERM").catch(() => undefined);
    }
    const command = `${context.installation.binaryPath} serve --hostname 127.0.0.1 --port ${port}`;
    const stopped = await this.executor.exec(
      `pids="$(pgrep -f -x -- ${shellQuote(command)} || true)"; if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; sleep 0.25; for pid in $pids; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done; fi`,
    );
    invariant(stopped.code === 0, "AGENT_SERVICE_RESTART_FAILED", "无法重新载入 OpenCode 隔离配置", { status: 502 });
    this.active.delete(activeEntryKey(context.request.binding));
  }

  async #openCodeRequest(context, entry, request, variables) {
    const resolved = deepSubstitute(request, variables);
    const model = String(context.apiRoute?.model || "").trim();
    if (context.installation.source === "managed" && model && resolved.path.includes("/prompt_async")) {
      // OpenCode persists the selected model on its native session. Sending the
      // isolated provider explicitly also repairs sessions created before a
      // managed configuration update.
      resolved.body = {
        ...(resolved.body && typeof resolved.body === "object" ? resolved.body : {}),
        model: { providerID: "easywork", modelID: model },
      };
    }
    const result = await this.executor.requestHttp({
      host: "127.0.0.1",
      port: entry.servicePort,
      method: resolved.method,
      path: resolved.path,
      body: resolved.body,
    });
    return result;
  }

  async #executeOpenCode(context) {
    invariant(["http"].includes(context.request.descriptor.transport), "AGENT_TRANSPORT_UNSUPPORTED", "OpenCode operation 需要 HTTP transport", {
      status: 409,
    });
    const entry = await this.#openCodeService(context);
    const operation = context.request.operation;
    let lines = null;
    const variables = {};
    let sessionId = String(
      context.request.binding.native?.sessionId
        || context.request.binding.state?.sessionId
        || openCodeRequestSessionId(context.request.descriptor.request)
        || "",
    );
    let baselineMessageIds = new Set();
    if (["start", "resume"].includes(operation) && sessionId) {
      const existingMessages = await openCodeMessages(this.executor, entry.servicePort, sessionId);
      baselineMessageIds = new Set(existingMessages.map(openCodeMessageId).filter(Boolean));
    }
    if (Array.isArray(context.request.descriptor.transaction)) {
      for (const [index, request] of context.request.descriptor.transaction.entries()) {
        const result = await this.#openCodeRequest(context, entry, request, variables);
        const createdSessionId = result?.id || result?.session?.id;
        if (createdSessionId) {
          variables["$session.id"] = String(createdSessionId);
          sessionId = String(createdSessionId);
        }
        // OpenCode does not emit useful work events while a native session is
        // being created. Establishing the long-lived SSE channel only after
        // the session exists avoids an idle forwarded request blocking the
        // following HTTP transaction on SSH servers with conservative channel
        // limits, while still subscribing before the prompt starts executing.
        if (index === 0 && ["start", "resume"].includes(operation)) {
          lines = await this.executor.openHttpEventStream({ host: "127.0.0.1", port: entry.servicePort, path: "/event" });
        }
      }
      invariant(variables["$session.id"], "AGENT_NATIVE_SESSION_MISSING", "OpenCode 未返回 session id", { status: 502 });
    } else {
      if (["start", "resume"].includes(operation)) {
        lines = await this.executor.openHttpEventStream({ host: "127.0.0.1", port: entry.servicePort, path: "/event" });
      }
      await this.#openCodeRequest(context, entry, context.request.descriptor.request, variables);
    }
    if (operation === "interrupt") {
      const sessionId = String(
        context.request.binding.native?.sessionId
          || context.request.binding.state?.sessionId
          || "",
      );
      invariant(sessionId, "AGENT_NATIVE_SESSION_MISSING", "OpenCode interrupt 缺少 native session", { status: 409 });
      let interrupted = false;
      for (let attempt = 0; attempt < 3 && !interrupted; attempt += 1) {
        if (attempt > 0) {
          await this.executor.requestHttp({
            host: "127.0.0.1",
            port: entry.servicePort,
            method: "POST",
            path: `/session/${encodeURIComponent(sessionId)}/abort`,
          });
        }
        for (let poll = 0; poll < 10; poll += 1) {
          const snapshot = await this.executor.requestHttp({
            host: "127.0.0.1",
            port: entry.servicePort,
            method: "GET",
            path: "/session/status",
          });
          if (!openCodeSessionIsBusy(snapshot, sessionId)) {
            interrupted = true;
            break;
          }
          await sleep(100);
        }
      }
      invariant(interrupted, "AGENT_INTERRUPT_NOT_CONFIRMED", "OpenCode 未确认任务已停止", {
        status: 502,
        retryable: true,
      });
    }
    const runId = ["start", "resume"].includes(operation)
      ? createRuntimeRunId(context.agentId, context.bindingId, this.clock)
      : nativeRunId(context.request.binding);
    await this.#recordRuntime(context, {
      runId,
      status: operation === "interrupt" ? "interrupted" : "running",
      processId: entry.process?.processId || context.request.binding.native?.processId || null,
      servicePort: entry.servicePort,
    });
    return {
      runId,
      bindingPatch: {
        native: {
          agentSource: context.installation.source,
          binaryPath: context.installation.binaryPath,
          processId: entry.process?.processId || context.request.binding.native?.processId || null,
          servicePort: entry.servicePort,
          runtimeRoot: context.paths.runtimeRoot,
          skillsRoot: context.paths.skillsRoot,
          ...(context.runtimeFingerprint ? { runtimeFingerprint: context.runtimeFingerprint } : {}),
          ...(context.request.__runtimeProxy ? { apiProxy: context.request.__runtimeProxy } : {}),
        },
      },
      ...(lines ? {
        frames: resilientOpenCodeFrames({
          lines,
          executor: this.executor,
          port: entry.servicePort,
          sessionId,
          baselineMessageIds,
          pollIntervalMs: this.openCodePollIntervalMs,
        }),
      } : {}),
    };
  }

  async #codexProcess(context) {
    const key = activeEntryKey(context.request.binding);
    let entry = this.active.get(key);
    if (entry?.agentId === "codex" && entry.process && !entry.process.closed) return entry;
    const process = await this.executor.spawn({
      executable: context.installation.binaryPath,
      args: ["app-server"],
      cwd: context.request.workspace?.path || context.paths.runtimeHome,
      env: context.environment,
    });
    await process.requestJsonRpc("initialize", {
      clientInfo: { name: "easywork", title: "EasyWork", version: "2" },
      capabilities: { experimentalApi: true },
    });
    invariant(typeof process.notifyJsonRpc === "function", "AGENT_CODEX_INITIALIZE_UNSUPPORTED", "Codex process 不支持 initialized notification", {
      status: 500,
      expose: false,
    });
    process.notifyJsonRpc("initialized");
    entry = { agentId: "codex", process };
    this.active.set(key, entry);
    process.wait?.().finally(() => {
      if (this.active.get(key)?.process === process) this.active.delete(key);
      void this.#releaseProxy(context.bindingId);
    }).catch(() => {});
    return entry;
  }

  async #executeCodex(context) {
    invariant(context.request.descriptor.transport === "json-rpc", "AGENT_TRANSPORT_UNSUPPORTED", "Codex operation 需要 JSON-RPC transport", {
      status: 409,
    });
    const operation = context.request.operation;
    const key = activeEntryKey(context.request.binding);
    const previous = this.active.get(key);
    const hadLiveProcess = previous?.agentId === "codex" && previous.process && !previous.process.closed;
    if (["append", "interrupt"].includes(operation) && !hadLiveProcess) {
      throw new ApiError("AGENT_NATIVE_PROCESS_UNAVAILABLE", `Codex ${operation} 必须命中当前 app-server 进程`, {
        status: 409,
        details: { operation },
      });
    }
    const entry = await this.#codexProcess(context);
    if (!hadLiveProcess && typeof entry.process.discardBufferedLines === "function") entry.process.discardBufferedLines();
    const lines = ["start", "resume"].includes(operation) ? entry.process.lines() : null;
    const variables = {};
    const nativeThreadId = context.request.binding.native?.threadId || context.request.binding.state?.sessionId;
    const calls = context.request.descriptor.calls || [];
    if (!hadLiveProcess && nativeThreadId && operation !== "resume" && calls[0]?.method !== "thread/resume") {
      const resumed = await entry.process.requestJsonRpc("thread/resume", { threadId: nativeThreadId });
      variables["$thread.id"] = String(resumed?.thread?.id || resumed?.id || nativeThreadId);
    }
    for (const call of calls) {
      const params = deepSubstitute(call.params || {}, variables);
      const result = await entry.process.requestJsonRpc(call.method, params);
      if (call.method === "thread/start" || call.method === "thread/resume") {
        const threadId = result?.thread?.id || result?.id || params.threadId;
        if (threadId) variables["$thread.id"] = String(threadId);
      }
    }
    const runId = ["start", "resume"].includes(operation)
      ? createRuntimeRunId(context.agentId, context.bindingId, this.clock)
      : nativeRunId(context.request.binding);
    await this.#recordRuntime(context, {
      runId,
      status: operation === "interrupt" ? "interrupted" : "running",
      processId: entry.process.processId,
      threadId: variables["$thread.id"] || nativeThreadId || null,
    });
    return {
      runId,
      bindingPatch: {
        native: {
          agentSource: context.installation.source,
          binaryPath: context.installation.binaryPath,
          processId: entry.process.processId,
          runtimeRoot: context.paths.runtimeRoot,
          skillsRoot: context.paths.skillsRoot,
          ...(variables["$thread.id"] ? { threadId: variables["$thread.id"] } : {}),
          ...(context.request.__runtimeProxy ? { apiProxy: context.request.__runtimeProxy } : {}),
        },
      },
      ...(lines ? { frames: parsedFrames(lines) } : {}),
    };
  }

  async #claudeProcess(context) {
    const descriptor = context.request.descriptor;
    const args = [...(descriptor.args || [])];
    if (context.installation.source === "managed") {
      if (context.configuration.model) args.push("--model", context.configuration.model);
      if (context.configuration.effortLevel) args.push("--effort", context.configuration.effortLevel);
      if (context.configuration.permissionMode) args.push("--permission-mode", context.configuration.permissionMode);
    }
    const existingSessionId = context.request.binding.native?.sessionId || context.request.binding.state?.sessionId;
    if (context.request.operation === "start" && existingSessionId && !args.includes("--resume")) {
      args.push("--resume", String(existingSessionId));
    }
    const process = await this.executor.spawn({
      executable: context.installation.binaryPath,
      args,
      cwd: descriptor.cwd || context.request.workspace?.path || context.paths.runtimeHome,
      env: context.environment,
    });
    const key = activeEntryKey(context.request.binding);
    const entry = { agentId: "claude-code", process };
    this.active.set(key, entry);
    process.wait?.().finally(() => {
      if (this.active.get(key)?.process === process) this.active.delete(key);
      void this.#releaseProxy(context.bindingId);
    }).catch(() => {});
    return entry;
  }

  async #executeClaudeCode(context) {
    const descriptor = context.request.descriptor;
    const operation = context.request.operation;
    const key = activeEntryKey(context.request.binding);
    let entry = this.active.get(key);
    if (descriptor.transport === "process-jsonl") {
      entry = await this.#claudeProcess(context);
      const lines = entry.process.lines();
      for (const frame of descriptor.stdin || []) entry.process.writeJson(frame);
      const runId = createRuntimeRunId(context.agentId, context.bindingId, this.clock);
      await this.#recordRuntime(context, {
        runId,
        status: "running",
        processId: entry.process.processId,
        sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
      });
      return {
        runId,
        bindingPatch: {
          native: {
            agentSource: context.installation.source,
            binaryPath: context.installation.binaryPath,
            processId: entry.process.processId,
            runtimeRoot: context.paths.runtimeRoot,
            skillsRoot: context.paths.skillsRoot,
            ...(context.request.__runtimeProxy ? { apiProxy: context.request.__runtimeProxy } : {}),
          },
        },
        frames: parsedFrames(lines),
      };
    }
    invariant(entry?.agentId === "claude-code" && entry.process && !entry.process.closed, "AGENT_NATIVE_PROCESS_UNAVAILABLE", "Claude Code 原生进程已不可用", {
      status: 409,
      details: { operation },
    });
    if (descriptor.transport === "process-jsonl-stdin") {
      for (const frame of descriptor.frames || []) entry.process.writeJson(frame);
    } else if (descriptor.transport === "process-signal") {
      invariant(String(descriptor.processId) === String(entry.process.processId), "AGENT_NATIVE_PROCESS_MISMATCH", "interrupt 未命中当前 Claude Code 进程", {
        status: 409,
      });
      await entry.process.signal(descriptor.signal || "SIGINT");
    } else {
      return unsupportedCapability(context.agentId, operation, descriptor.transport);
    }
    await this.#recordRuntime(context, {
      runId: nativeRunId(context.request.binding),
      status: descriptor.transport === "process-signal" ? "interrupted" : "running",
      processId: entry.process.processId,
      sessionId: context.request.binding.native?.sessionId || context.request.binding.state?.sessionId || null,
    });
    return {
      runId: nativeRunId(context.request.binding),
      bindingPatch: {
        native: {
          agentSource: context.installation.source,
          binaryPath: context.installation.binaryPath,
          processId: entry.process.processId,
          runtimeRoot: context.paths.runtimeRoot,
          skillsRoot: context.paths.skillsRoot,
        },
      },
    };
  }
}

export { deepSubstitute, frameFromLine, parsedFrames, servicePort };
