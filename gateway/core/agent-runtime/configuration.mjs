import { ApiError, invariant } from "../errors.mjs";
import { remoteAgentPaths, runtimeAgentDefinition } from "./contract.mjs";
import { shellQuote } from "./ssh-executor.mjs";

const CONFIG_SCHEMA_VERSION = 1;
const MAX_CONFIG_BYTES = 256 * 1024;

const OPTION = (value, label) => Object.freeze({ value, label });

const SCHEMAS = Object.freeze({
  opencode: Object.freeze([
    Object.freeze({ key: "model", label: "模型", type: "string", nativeKey: "model" }),
    Object.freeze({ key: "permissionMode", label: "工具权限", type: "enum", nativeKey: "permission", options: [OPTION("ask", "每次询问"), OPTION("allow", "允许"), OPTION("deny", "拒绝")] }),
  ]),
  codex: Object.freeze([
    Object.freeze({ key: "model", label: "模型", type: "string", nativeKey: "model" }),
    Object.freeze({ key: "reasoningEffort", label: "思考强度", type: "enum", nativeKey: "model_reasoning_effort", options: [OPTION("low", "低"), OPTION("medium", "中"), OPTION("high", "高"), OPTION("xhigh", "极高")] }),
    Object.freeze({ key: "approvalPolicy", label: "审批策略", type: "enum", nativeKey: "approval_policy", options: [OPTION("untrusted", "仅可信命令免确认"), OPTION("on-request", "按需确认"), OPTION("never", "不请求确认")] }),
    Object.freeze({ key: "sandboxMode", label: "沙箱权限", type: "enum", nativeKey: "sandbox_mode", options: [OPTION("read-only", "只读"), OPTION("workspace-write", "可写工作区"), OPTION("danger-full-access", "完全访问")] }),
  ]),
  "claude-code": Object.freeze([
    Object.freeze({ key: "model", label: "模型", type: "string", nativeKey: "--model" }),
    Object.freeze({ key: "effortLevel", label: "思考强度", type: "enum", nativeKey: "CLAUDE_CODE_EFFORT_LEVEL", options: [OPTION("auto", "跟随模型"), OPTION("low", "低"), OPTION("medium", "中"), OPTION("high", "高"), OPTION("xhigh", "极高"), OPTION("max", "最大")] }),
    Object.freeze({ key: "permissionMode", label: "权限模式", type: "enum", nativeKey: "--permission-mode", options: [OPTION("default", "默认"), OPTION("acceptEdits", "自动接受文件编辑"), OPTION("plan", "计划模式"), OPTION("auto", "自动安全检查"), OPTION("dontAsk", "只运行预先允许的工具"), OPTION("bypassPermissions", "跳过权限检查")] }),
  ]),
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

function validateValues(agentId, input) {
  exactKeys(input, schemaFor(agentId).map((field) => field.key), "AGENT_CONFIG_VALUES_INVALID", "Agent 配置包含不支持的字段");
  const values = {};
  for (const field of schemaFor(agentId)) {
    if (!(field.key in input)) continue;
    const value = String(input[field.key] ?? "").trim();
    if (field.type === "string") invariant(value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value), "AGENT_CONFIG_VALUE_INVALID", `${field.label} 无效`, { status: 400, details: { field: field.key } });
    else invariant(field.options.some((option) => option.value === value), "AGENT_CONFIG_VALUE_INVALID", `${field.label} 不支持该选项`, { status: 400, details: { field: field.key } });
    values[field.key] = value;
  }
  return values;
}

function normalizeDocument(agentId, document) {
  if (document === null) return { schemaVersion: CONFIG_SCHEMA_VERSION, agentId, revision: 0, values: {}, updatedAt: null };
  invariant(document && document.schemaVersion === CONFIG_SCHEMA_VERSION && document.agentId === agentId && Number.isSafeInteger(document.revision) && document.revision >= 0, "AGENT_MANAGED_CONFIG_INVALID", "EasyWork Agent 配置格式无效", { status: 502 });
  exactKeys(document, ["schemaVersion", "agentId", "revision", "values", "updatedAt"], "AGENT_MANAGED_CONFIG_INVALID", "EasyWork Agent 配置格式无效");
  return { ...document, values: validateValues(agentId, document.values || {}) };
}

export class ManagedAgentConfiguration {
  constructor({ executor, deploymentService, clock = () => new Date() } = {}) {
    invariant(executor && typeof executor.home === "function" && typeof executor.readFile === "function" && typeof executor.writeAtomic === "function", "AGENT_CONFIG_EXECUTOR_REQUIRED", "缺少 Agent 配置远端执行器", { status: 500, expose: false });
    invariant(deploymentService && typeof deploymentService.status === "function", "AGENT_CONFIG_DEPLOYMENT_REQUIRED", "缺少 Agent 部署状态服务", { status: 500, expose: false });
    this.executor = executor;
    this.deploymentService = deploymentService;
    this.clock = clock;
    this.mutation = Promise.resolve();
  }

  async inspect(agentId, { source = null } = {}) {
    const installation = await this.deploymentService.status(agentId, { source });
    invariant(installation.installed, "AGENT_NOT_INSTALLED", `${installation.displayName} 未安装`, { status: 409 });
    if (!installation.managed) {
      return Object.freeze({ agentId, source: "user", managed: false, writable: false, revision: null, updatedAt: null, fields: [], values: {}, reason: "user-deployment-native-config" });
    }
    const { document, path } = await this.#read(agentId);
    return Object.freeze({ agentId, source: "managed", managed: true, writable: true, path, revision: document.revision, updatedAt: document.updatedAt, fields: structuredClone(schemaFor(agentId)), values: structuredClone(document.values) });
  }

  async update(agentId, input = {}) {
    const run = this.mutation.then(() => this.#update(agentId, input));
    this.mutation = run.catch(() => undefined);
    return run;
  }

  async #update(agentId, input) {
    exactKeys(input, ["source", "expectedRevision", "values"], "AGENT_CONFIG_PATCH_INVALID", "Agent 配置请求格式无效");
    invariant(input.source == null || input.source === "managed", "AGENT_CONFIG_READ_ONLY", "用户部署的 Agent 配置由其自身管理，EasyWork 只读", { status: 409 });
    invariant(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, "REVISION_INVALID", "expectedRevision 无效", { status: 400 });
    const installation = await this.deploymentService.status(agentId, { source: "managed" });
    invariant(installation.installed && installation.managed, "AGENT_CONFIG_READ_ONLY", "只有 EasyWork 部署的 Agent 可以修改隔离配置", { status: 409 });
    const patch = validateValues(agentId, input.values || {});
    invariant(Object.keys(patch).length > 0, "AGENT_CONFIG_PATCH_EMPTY", "Agent 配置没有可更新字段", { status: 400 });
    const { document, path, paths } = await this.#read(agentId);
    invariant(document.revision === input.expectedRevision, "REVISION_CONFLICT", "Agent 配置已被其他请求修改", { status: 409, details: { expectedRevision: input.expectedRevision, actualRevision: document.revision } });
    const next = { schemaVersion: CONFIG_SCHEMA_VERSION, agentId, revision: document.revision + 1, values: { ...document.values, ...patch }, updatedAt: new Date(this.clock()).toISOString() };
    await this.#prepare(paths);
    await this.executor.writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return this.inspect(agentId, { source: "managed" });
  }

  async runtimeValues(agentId) {
    const { document } = await this.#read(agentId);
    return structuredClone(document.values);
  }

  async #read(agentId) {
    const paths = remoteAgentPaths(await this.executor.home(), agentId);
    let document = null;
    try {
      const bytes = await this.executor.readFile(paths.managedRuntimeConfig);
      invariant(bytes.length <= MAX_CONFIG_BYTES, "AGENT_MANAGED_CONFIG_TOO_LARGE", "EasyWork Agent 配置超过大小限制", { status: 502 });
      document = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (!notFound(error)) {
        if (error instanceof SyntaxError) throw new ApiError("AGENT_MANAGED_CONFIG_INVALID", "EasyWork Agent 配置不是有效 JSON", { status: 502, cause: error });
        throw error;
      }
    }
    return { document: normalizeDocument(agentId, document), path: paths.managedRuntimeConfig, paths };
  }

  async #prepare(paths) {
    const guarded = [paths.easyworkRoot, `${paths.easyworkRoot}/agents`, paths.managedRoot, paths.managedRuntime];
    const result = await this.executor.exec(`for target in ${guarded.map(shellQuote).join(" ")}; do [ ! -L "$target" ] || exit 73; done; mkdir -p -- ${shellQuote(paths.managedRuntime)}; chmod 0700 -- ${shellQuote(paths.managedRuntime)}`, { maxOutputBytes: 16 * 1024 });
    invariant(result.code === 0, "AGENT_CONFIG_PATH_UNSAFE", "Agent 配置目录包含符号链接，已拒绝写入", { status: 409 });
  }
}

export const managedAgentConfigurationSchemas = SCHEMAS;
