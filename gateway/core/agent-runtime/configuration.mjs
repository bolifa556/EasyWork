import { ApiError, invariant } from "../errors.mjs";
import { assertRuntimeIdentifier, remoteAgentConfigurationPaths, runtimeAgentDefinition } from "./contract.mjs";
import { shellQuote } from "./ssh-executor.mjs";

const CONFIG_SCHEMA_VERSION = 3;
const MAX_CONFIG_BYTES = 256 * 1024;
const DEFAULT_AGENT_AUTO_COMPACT_WINDOW = "200000";

const OPTION = (value, label) => Object.freeze({ value, label });
const CONTEXT_LIMIT = (label, nativeKey) => Object.freeze({
  key: "contextLimit",
  label,
  type: "number",
  nativeKey,
});

const SCHEMAS = Object.freeze({
  opencode: Object.freeze([
    Object.freeze({ key: "model", label: "模型", type: "string", nativeKey: "model" }),
    CONTEXT_LIMIT("自动压缩窗口", "provider.easywork.models.<model>.limit.context"),
    Object.freeze({ key: "reasoningEffort", label: "思考强度", type: "enum", nativeKey: "variant", options: [OPTION("default", "默认（default）"), OPTION("minimal", "最低（minimal）"), OPTION("low", "低（low）"), OPTION("medium", "中等（medium）"), OPTION("high", "高（high）"), OPTION("xhigh", "极高（xhigh）"), OPTION("max", "最大（max）")] }),
    Object.freeze({ key: "permissionMode", label: "全局工具权限", type: "enum", nativeKey: "permission", options: [OPTION("ask", "每次询问"), OPTION("allow", "全部允许"), OPTION("deny", "全部禁止")] }),
  ]),
  codex: Object.freeze([
    Object.freeze({ key: "model", label: "模型", type: "string", nativeKey: "model" }),
    CONTEXT_LIMIT("自动压缩窗口", "model_auto_compact_token_limit"),
    Object.freeze({ key: "reasoningEffort", label: "思考强度", type: "enum", nativeKey: "model_reasoning_effort", options: [OPTION("minimal", "最低（minimal）"), OPTION("low", "低（low）"), OPTION("medium", "中等（medium）"), OPTION("high", "高（high）"), OPTION("xhigh", "极高（xhigh）")] }),
    Object.freeze({ key: "approvalPolicy", label: "审批策略", type: "enum", nativeKey: "approval_policy", options: [OPTION("untrusted", "仅信任命令免确认"), OPTION("on-request", "由 Agent 请求确认"), OPTION("never", "不请求确认")] }),
    Object.freeze({ key: "sandboxMode", label: "沙箱权限", type: "enum", nativeKey: "sandbox_mode", options: [OPTION("auto", "自动（兼容优先）"), OPTION("read-only", "只读沙箱"), OPTION("workspace-write", "工作区可写"), OPTION("danger-full-access", "完全访问（无沙箱）")] }),
  ]),
  "claude-code": Object.freeze([
    Object.freeze({ key: "model", label: "模型", type: "string", nativeKey: "--model" }),
    // The environment variable has highest precedence, which is exactly what
    // an isolated EasyWork runtime needs.
    CONTEXT_LIMIT("自动压缩窗口", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"),
    Object.freeze({ key: "effortLevel", label: "思考强度", type: "enum", nativeKey: "--effort", options: [OPTION("low", "低（low）"), OPTION("medium", "中等（medium）"), OPTION("high", "高（high）"), OPTION("xhigh", "极高（xhigh）"), OPTION("max", "最大（max，本次会话）")] }),
    Object.freeze({ key: "permissionMode", label: "权限模式", type: "enum", nativeKey: "--permission-mode", options: [OPTION("default", "逐项询问"), OPTION("acceptEdits", "自动接受文件编辑（Bash 仍询问）"), OPTION("plan", "仅规划（只读）"), OPTION("auto", "自动安全审查（仅 Anthropic API）"), OPTION("dontAsk", "仅使用预先批准的工具"), OPTION("bypassPermissions", "跳过权限检查（危险）")] }),
  ]),
});

// These values are the effective defaults of a newly isolated conversation.
const DEFAULT_VALUES = Object.freeze({
  opencode: Object.freeze({ contextLimit: DEFAULT_AGENT_AUTO_COMPACT_WINDOW, reasoningEffort: "default", permissionMode: "allow" }),
  codex: Object.freeze({ contextLimit: DEFAULT_AGENT_AUTO_COMPACT_WINDOW, reasoningEffort: "medium", approvalPolicy: "never", sandboxMode: "auto" }),
  "claude-code": Object.freeze({ contextLimit: DEFAULT_AGENT_AUTO_COMPACT_WINDOW, effortLevel: "medium", permissionMode: "acceptEdits" }),
});

const EFFORT_FIELDS = Object.freeze({
  opencode: "reasoningEffort",
  codex: "reasoningEffort",
  "claude-code": "effortLevel",
});

function notFound(error) {
  return ["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code) || /no such file/i.test(String(error?.message || ""));
}

function exactKeys(value, allowed, code, message) {
  invariant(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key)), code, message, { status: 400 });
}

function schemaFor(agentId) {
  runtimeAgentDefinition(agentId);
  return SCHEMAS[agentId];
}

function scopeOf(value) {
  return assertRuntimeIdentifier(value || "default", "configScope");
}

function snapshotKey(agentId, configScope) {
  return `${scopeOf(configScope)}\0${String(agentId)}`;
}

function validateValues(agentId, input) {
  exactKeys(input, schemaFor(agentId).map((field) => field.key), "AGENT_CONFIG_VALUES_INVALID", "Agent 配置包含不支持的字段");
  const values = {};
  for (const field of schemaFor(agentId)) {
    if (!(field.key in input)) continue;
    const value = String(input[field.key] ?? "").trim();
    if (field.type === "string") invariant(value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value), "AGENT_CONFIG_VALUE_INVALID", `${field.label} 无效`, { status: 400, details: { field: field.key } });
    else if (field.type === "number") {
      const numeric = Number(value);
      invariant(Number.isSafeInteger(numeric), "AGENT_CONFIG_VALUE_INVALID", `${field.label} 必须是整数`, { status: 400, details: { field: field.key } });
    } else invariant(field.options.some((option) => option.value === value), "AGENT_CONFIG_VALUE_INVALID", `${field.label} 不支持该选项`, { status: 400, details: { field: field.key } });
    values[field.key] = value;
  }
  return values;
}

function normalizeDocument(agentId, document) {
  const defaults = DEFAULT_VALUES[agentId] || {};
  if (document === null) return { schemaVersion: CONFIG_SCHEMA_VERSION, agentId, revision: 0, values: { ...defaults }, updatedAt: null };
  invariant(document && [1, 2, CONFIG_SCHEMA_VERSION].includes(document.schemaVersion) && document.agentId === agentId && Number.isSafeInteger(document.revision) && document.revision >= 0, "AGENT_MANAGED_CONFIG_INVALID", "EasyWork Agent 配置格式无效", { status: 502 });
  exactKeys(document, ["schemaVersion", "agentId", "revision", "values", "updatedAt"], "AGENT_MANAGED_CONFIG_INVALID", "EasyWork Agent 配置格式无效");
  const migratedValues = { ...(document.values || {}) };
  // Schema v1 materialized the old Codex default as workspace-write. Hosts
  // without a usable bubblewrap then failed before a turn could start. V2
  // preserves explicit V2 choices while moving that legacy default to the
  // capability-aware automatic mode.
  if (agentId === "codex" && document.schemaVersion === 1 && migratedValues.sandboxMode === "workspace-write") {
    migratedValues.sandboxMode = "auto";
  }
  return {
    ...document,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    values: { ...defaults, ...validateValues(agentId, migratedValues) },
  };
}

export class ManagedAgentConfiguration {
  constructor({ executor, deploymentService, actorId, clock = () => new Date() } = {}) {
    invariant(executor && typeof executor.home === "function" && typeof executor.readFile === "function" && typeof executor.writeAtomic === "function", "AGENT_CONFIG_EXECUTOR_REQUIRED", "缺少 Agent 配置远端执行器", { status: 500, expose: false });
    invariant(deploymentService && typeof deploymentService.status === "function", "AGENT_CONFIG_DEPLOYMENT_REQUIRED", "缺少 Agent 部署状态服务", { status: 500, expose: false });
    this.executor = executor;
    this.deploymentService = deploymentService;
    this.actorId = assertRuntimeIdentifier(actorId, "actorId");
    this.clock = clock;
    this.mutations = new Map();
    this.materializations = new Map();
    this.snapshots = new Map();
    this.runtimeValuesCache = new Map();
    this.inheritedScopes = new Set();
  }

  #mutate(key, worker) {
    const previous = this.mutations.get(key) || Promise.resolve();
    const run = previous.then(worker);
    const settled = run.catch(() => undefined);
    this.mutations.set(key, settled);
    void settled.finally(() => {
      if (this.mutations.get(key) === settled) this.mutations.delete(key);
    });
    return run;
  }

  async inspect(agentId, { source = null, configScope = "default" } = {}) {
    const scope = scopeOf(configScope);
    const installation = await this.deploymentService.status(agentId, { source });
    invariant(installation.installed, "AGENT_NOT_INSTALLED", `${installation.displayName} 未安装`, { status: 409 });
    const { document, path, inherited } = await this.#read(agentId, scope);
    return this.#rememberConfiguration(agentId, scope, installation, document, path, inherited);
  }

  #rememberConfiguration(agentId, scope, installation, document, path, inherited = false) {
    const key = snapshotKey(agentId, scope);
    const configuration = Object.freeze({
      agentId,
      configScope: scope,
      source: installation.source,
      managed: installation.managed,
      writable: true,
      path,
      inherited,
      revision: document.revision,
      updatedAt: document.updatedAt,
      fields: structuredClone(schemaFor(agentId)),
      values: structuredClone(document.values),
    });
    this.snapshots.set(key, structuredClone(configuration));
    this.runtimeValuesCache.set(key, structuredClone(document.values));
    if (inherited) this.inheritedScopes.add(key);
    else this.inheritedScopes.delete(key);
    return configuration;
  }

  snapshot(agentId, { configScope = "default" } = {}) {
    const value = this.snapshots.get(snapshotKey(agentId, configScope));
    return value ? structuredClone(value) : null;
  }

  async update(agentId, input = {}) {
    return this.#mutate(snapshotKey(agentId, input.configScope || "default"), () => this.#update(agentId, input));
  }

  async adaptEffort(agentId, input = {}) {
    return this.#mutate(snapshotKey(agentId, input.configScope || "default"), () => this.#adaptEffort(agentId, input));
  }

  async #adaptEffort(agentId, input) {
    exactKeys(input, ["source", "configScope", "configuredValue", "requestedEffort", "appliedEffort"], "AGENT_EFFORT_ADAPTATION_INVALID", "Agent 思考强度适配请求格式无效");
    const configScope = scopeOf(input.configScope);
    invariant(input.source == null || ["managed", "user"].includes(input.source), "AGENT_CONFIG_SOURCE_INVALID", "Agent 配置来源无效", { status: 400 });
    const field = EFFORT_FIELDS[agentId];
    invariant(field, "AGENT_EFFORT_ADAPTATION_UNSUPPORTED", `${agentId} 不支持自动调整思考强度`, { status: 409 });
    const configuredValue = String(input.configuredValue || "").trim();
    const requestedEffort = String(input.requestedEffort || "").trim().toLowerCase();
    const appliedEffort = String(input.appliedEffort || "").trim().toLowerCase();
    invariant(configuredValue && requestedEffort && appliedEffort && requestedEffort !== appliedEffort, "AGENT_EFFORT_ADAPTATION_INVALID", "Agent 思考强度适配值无效", { status: 400 });
    validateValues(agentId, { [field]: appliedEffort });

    const installation = await this.deploymentService.status(agentId, { source: input.source || null });
    invariant(installation.installed, "AGENT_NOT_INSTALLED", `${installation.displayName} 未安装`, { status: 409 });
    const { document, path, paths, inherited } = await this.#read(agentId, configScope);
    const currentValue = String(document.values[field] || "");
    if (currentValue === appliedEffort || currentValue !== configuredValue) {
      return Object.freeze({
        changed: false,
        field,
        requestedEffort,
        appliedEffort,
        currentValue,
        configuration: this.#rememberConfiguration(agentId, configScope, installation, document, path, inherited),
      });
    }

    const next = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      agentId,
      revision: document.revision + 1,
      values: { ...document.values, [field]: appliedEffort },
      updatedAt: new Date(this.clock()).toISOString(),
    };
    await this.#prepare(paths);
    await this.executor.writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    const writtenKey = snapshotKey(agentId, configScope);
    this.runtimeValuesCache.set(writtenKey, structuredClone(next.values));
    this.inheritedScopes.delete(writtenKey);
    if (configScope === "default") {
      for (const inheritedKey of [...this.inheritedScopes]) {
        if (!inheritedKey.endsWith(`\0${agentId}`)) continue;
        this.runtimeValuesCache.delete(inheritedKey);
        this.snapshots.delete(inheritedKey);
      }
    }
    return Object.freeze({
      changed: true,
      field,
      requestedEffort,
      appliedEffort,
      currentValue: appliedEffort,
      configuration: this.#rememberConfiguration(agentId, configScope, installation, next, path, false),
    });
  }

  async #update(agentId, input) {
    exactKeys(input, ["source", "configScope", "expectedRevision", "values"], "AGENT_CONFIG_PATCH_INVALID", "Agent 配置请求格式无效");
    const configScope = scopeOf(input.configScope);
    invariant(input.source == null || ["managed", "user"].includes(input.source), "AGENT_CONFIG_SOURCE_INVALID", "Agent 配置来源无效", { status: 400 });
    invariant(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, "REVISION_INVALID", "expectedRevision 无效", { status: 400 });
    const installation = await this.deploymentService.status(agentId, { source: input.source || null });
    invariant(installation.installed, "AGENT_NOT_INSTALLED", `${installation.displayName} 未安装`, { status: 409 });
    const patch = validateValues(agentId, input.values || {});
    invariant(Object.keys(patch).length > 0, "AGENT_CONFIG_PATCH_EMPTY", "Agent 配置没有可更新字段", { status: 400 });
    const { document, path, paths } = await this.#read(agentId, configScope);
    invariant(document.revision === input.expectedRevision, "REVISION_CONFLICT", "Agent 配置已被其他请求修改", { status: 409, details: { expectedRevision: input.expectedRevision, actualRevision: document.revision } });
    const next = { schemaVersion: CONFIG_SCHEMA_VERSION, agentId, revision: document.revision + 1, values: { ...document.values, ...patch }, updatedAt: new Date(this.clock()).toISOString() };
    await this.#prepare(paths);
    await this.executor.writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    const writtenKey = snapshotKey(agentId, configScope);
    this.runtimeValuesCache.set(writtenKey, structuredClone(next.values));
    this.inheritedScopes.delete(writtenKey);
    if (configScope === "default") {
      for (const inheritedKey of [...this.inheritedScopes]) {
        if (!inheritedKey.endsWith(`\0${agentId}`)) continue;
        this.runtimeValuesCache.delete(inheritedKey);
        this.snapshots.delete(inheritedKey);
      }
    }
    return this.inspect(agentId, { source: installation.source, configScope });
  }

  async runtimeValues(agentId, { configScope = "default" } = {}) {
    const scope = scopeOf(configScope);
    const materialization = this.materializations.get(scope);
    if (materialization) await materialization;
    const key = snapshotKey(agentId, scope);
    const cached = this.runtimeValuesCache.get(key);
    if (cached) return structuredClone(cached);
    const { document, inherited } = await this.#read(agentId, scope);
    this.runtimeValuesCache.set(key, structuredClone(document.values));
    if (inherited) this.inheritedScopes.add(key);
    else this.inheritedScopes.delete(key);
    return structuredClone(document.values);
  }

  async materializeScopes(agentIds, input = {}) {
    exactKeys(input, ["sourceScope", "targetScope"], "AGENT_CONFIG_SCOPES_MATERIALIZE_INVALID", "Agent 配置作用域物化请求无效");
    invariant(Array.isArray(agentIds) && agentIds.length > 0, "AGENT_CONFIG_SCOPE_AGENTS_INVALID", "Agent 配置物化列表无效", { status: 400 });
    const ids = [...new Set(agentIds.map(String))];
    ids.forEach(schemaFor);
    const sourceScope = scopeOf(input.sourceScope);
    const targetScope = scopeOf(input.targetScope);
    const run = this.#mutate(`materialize\0${targetScope}`, async () => {
      const home = await this.executor.home();
      const installations = await Promise.all(ids.map((agentId) => this.deploymentService.status(agentId)));
      installations.forEach((installation) => invariant(installation.installed, "AGENT_NOT_INSTALLED", `${installation.displayName} 未安装`, { status: 409 }));
      const targets = ids.map((agentId) => remoteAgentConfigurationPaths(home, agentId, this.actorId, targetScope));
      const existing = await Promise.all(ids.map((agentId, index) => this.#readDocument(targets[index].configurationFile, agentId)));
      const missing = ids.map((agentId, index) => existing[index] ? null : {
        agentId,
        index,
        source: remoteAgentConfigurationPaths(home, agentId, this.actorId, sourceScope),
      }).filter(Boolean);
      const sourceDocuments = await Promise.all(missing.map((entry) => this.#readDocument(entry.source.configurationFile, entry.agentId)));
      const nextDocuments = [...existing];
      for (const [missingIndex, entry] of missing.entries()) {
        const sourceDocument = sourceDocuments[missingIndex] || normalizeDocument(entry.agentId, null);
        nextDocuments[entry.index] = {
          schemaVersion: CONFIG_SCHEMA_VERSION,
          agentId: entry.agentId,
          revision: 0,
          values: structuredClone(sourceDocument.values),
          updatedAt: new Date(this.clock()).toISOString(),
        };
      }
      if (missing.length) {
        await this.#prepareMany(missing.map((entry) => targets[entry.index]));
        await Promise.all(missing.map((entry) => this.executor.writeAtomic(
          targets[entry.index].configurationFile,
          `${JSON.stringify(nextDocuments[entry.index], null, 2)}\n`,
          { mode: 0o600 },
        )));
      }
      return ids.map((agentId, index) => this.#rememberConfiguration(
        agentId,
        targetScope,
        installations[index],
        nextDocuments[index],
        targets[index].configurationFile,
        false,
      ));
    });
    this.materializations.set(targetScope, run);
    try { return await run; }
    finally {
      if (this.materializations.get(targetScope) === run) this.materializations.delete(targetScope);
    }
  }

  async #readDocument(remotePath, agentId) {
    try {
      const bytes = await this.executor.readFile(remotePath);
      invariant(bytes.length <= MAX_CONFIG_BYTES, "AGENT_MANAGED_CONFIG_TOO_LARGE", "EasyWork Agent 配置超过大小限制", { status: 502 });
      return normalizeDocument(agentId, JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (!notFound(error)) {
        if (error instanceof SyntaxError) throw new ApiError("AGENT_MANAGED_CONFIG_INVALID", "EasyWork Agent 配置不是有效 JSON", { status: 502, cause: error });
        throw error;
      }
      return null;
    }
  }

  async #read(agentId, configScope = "default") {
    const home = await this.executor.home();
    const scope = scopeOf(configScope);
    const paths = remoteAgentConfigurationPaths(home, agentId, this.actorId, scope);
    const scoped = await this.#readDocument(paths.configurationFile, agentId);
    if (scoped) return { document: scoped, path: paths.configurationFile, paths, inherited: false };
    if (scope !== "default") {
      const defaults = remoteAgentConfigurationPaths(home, agentId, this.actorId, "default");
      const inherited = await this.#readDocument(defaults.configurationFile, agentId);
      if (inherited) return { document: inherited, path: paths.configurationFile, paths, inherited: true };
    }
    return {
      document: normalizeDocument(agentId, null),
      path: paths.configurationFile,
      paths,
      inherited: false,
    };
  }

  async #prepare(paths) {
    return this.#prepareMany([paths]);
  }

  async #prepareMany(pathsList) {
    const guarded = [...new Set(pathsList.flatMap((paths) => [paths.easyworkRoot, `${paths.easyworkRoot}/runtime`, paths.conversationsRoot, paths.conversationRoot, `${paths.conversationRoot}/agents`, paths.configurationRoot]))];
    const roots = [...new Set(pathsList.map((paths) => paths.configurationRoot))];
    const result = await this.executor.exec(`for target in ${guarded.map(shellQuote).join(" ")}; do [ ! -L "$target" ] || exit 73; done; mkdir -p -- ${roots.map(shellQuote).join(" ")}; chmod 0700 -- ${roots.map(shellQuote).join(" ")}`, { maxOutputBytes: 16 * 1024 });
    invariant(result.code === 0, "AGENT_CONFIG_PATH_UNSAFE", "Agent 配置目录包含符号链接，已拒绝写入", { status: 409 });
  }
}

export const managedAgentConfigurationSchemas = SCHEMAS;
export const managedAgentConfigurationDefaults = DEFAULT_VALUES;
