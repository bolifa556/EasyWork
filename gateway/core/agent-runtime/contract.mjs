import crypto from "node:crypto";
import path from "node:path";

import { ApiError, invariant } from "../errors.mjs";

export const AGENT_RUNTIME_SCHEMA_VERSION = 1;

export const RUNTIME_AGENT_IDS = Object.freeze(["opencode", "codex", "claude-code"]);

export const MANAGED_AGENT_DEFINITIONS = Object.freeze({
  opencode: Object.freeze({
    id: "opencode",
    packageId: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    launch: Object.freeze(["serve"]),
  }),
  codex: Object.freeze({
    id: "codex",
    packageId: "codex",
    displayName: "Codex",
    binary: "codex",
    launch: Object.freeze(["app-server"]),
  }),
  "claude-code": Object.freeze({
    id: "claude-code",
    packageId: "claudecode",
    displayName: "Claude Code",
    binary: "claude",
    launch: Object.freeze([]),
  }),
});

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PLATFORM_PATTERN = /^linux-(?:x64|arm64)(?:-musl)?$/;

export function runtimeAgentDefinition(agentId) {
  const definition = MANAGED_AGENT_DEFINITIONS[String(agentId || "")];
  invariant(definition, "AGENT_RUNTIME_UNKNOWN", `未知 Agent：${String(agentId || "")}`, { status: 400 });
  return definition;
}

export function assertRuntimeIdentifier(value, field = "id") {
  const id = String(value || "");
  invariant(IDENTIFIER_PATTERN.test(id), "AGENT_RUNTIME_ID_INVALID", `${field} 格式无效`, {
    status: 400,
    details: { field },
  });
  return id;
}

export function assertLinuxPlatform(value) {
  const platform = String(value || "");
  invariant(PLATFORM_PATTERN.test(platform), "AGENT_PLATFORM_UNSUPPORTED", `不支持的 Agent 平台：${platform || "unknown"}`, {
    status: 409,
    details: { platform: platform || null },
  });
  return platform;
}

export function normalizeLinuxPlatform({ os, arch, musl = false } = {}) {
  const normalizedOs = String(os || "").trim().toLowerCase();
  const normalizedArch = String(arch || "").trim().toLowerCase();
  invariant(normalizedOs === "linux", "AGENT_PLATFORM_UNSUPPORTED", `Agent 仅支持 Linux，当前为 ${normalizedOs || "unknown"}`, {
    status: 409,
  });
  const architecture = ["x86_64", "amd64", "x64"].includes(normalizedArch)
    ? "x64"
    : ["aarch64", "arm64"].includes(normalizedArch)
      ? "arm64"
      : "";
  invariant(architecture, "AGENT_PLATFORM_UNSUPPORTED", `不支持的 CPU 架构：${normalizedArch || "unknown"}`, {
    status: 409,
  });
  return `linux-${architecture}${musl ? "-musl" : ""}`;
}

export function bindingDirectoryName(bindingId) {
  const id = assertRuntimeIdentifier(bindingId, "agentBindingId");
  const readable = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 20);
  return `${readable}-${digest}`;
}

export function configurationScopeDirectoryName(actorId, configScope) {
  const actor = assertRuntimeIdentifier(actorId, "actorId");
  const scope = assertRuntimeIdentifier(configScope || "default", "configScope");
  const readable = scope.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  const digest = crypto.createHash("sha256").update(actor).update("\0").update(scope).digest("hex").slice(0, 20);
  return `${readable}-${digest}`;
}

function assertAbsoluteHome(home) {
  const value = path.posix.normalize(String(home || ""));
  invariant(value.startsWith("/") && value !== "/", "AGENT_REMOTE_HOME_INVALID", "远端 HOME 无效", { status: 409 });
  return value.replace(/\/$/, "");
}

export function remoteAgentPaths(home, agentId, bindingId = null) {
  const normalizedHome = assertAbsoluteHome(home);
  const definition = runtimeAgentDefinition(agentId);
  const easyworkRoot = `${normalizedHome}/.easywork`;
  const managedRoot = `${easyworkRoot}/agents/${definition.packageId}`;
  const result = {
    home: normalizedHome,
    easyworkRoot,
    managedRoot,
    managedCurrent: `${managedRoot}/current`,
    managedBinary: `${managedRoot}/current/bin/${definition.binary}`,
    managedState: `${managedRoot}/state.json`,
    managedReleases: `${managedRoot}/releases`,
    runtimeReleases: `${easyworkRoot}/runtime/releases`,
    agentCacheRoot: `${easyworkRoot}/cache/agents/${agentId}`,
    registryRoot: `${easyworkRoot}/runtime/agents/registry`,
    // Immutable packages are cached once per server.  Every exact native
    // conversation binding receives its own view below, so selecting a Skill
    // for one webpage conversation never exposes it to another binding.
    skillCacheRoot: `${easyworkRoot}/skills`,
    skillsRoot: `${easyworkRoot}/skills`,
  };
  if (bindingId !== null && bindingId !== undefined) {
    const bindingDirectory = bindingDirectoryName(bindingId);
    const agentRuntimeRoot = `${easyworkRoot}/runtime/agents/${agentId}`;
    const runtimeRoot = `${agentRuntimeRoot}/${bindingDirectory}`;
    Object.assign(result, {
      bindingDirectory,
      agentRuntimeRoot,
      runtimeRoot,
      runtimeHome: `${runtimeRoot}/home`,
      runtimeConfig: `${runtimeRoot}/config`,
      runtimeData: `${runtimeRoot}/data`,
      runtimeCache: `${runtimeRoot}/cache`,
      runtimeState: `${runtimeRoot}/state`,
      runtimeLogs: `${runtimeRoot}/logs`,
      providerConfiguration: `${runtimeRoot}/config/provider.json`,
      providerEnvironment: `${runtimeRoot}/config/provider.env`,
      skillsRoot: `${runtimeRoot}/skills`,
    });
  }
  return Object.freeze(result);
}

export function remoteAgentConfigurationPaths(home, agentId, actorId, configScope) {
  const base = remoteAgentPaths(home, agentId);
  const definition = runtimeAgentDefinition(agentId);
  const scopeDirectory = configurationScopeDirectoryName(actorId, configScope);
  const conversationsRoot = `${base.easyworkRoot}/runtime/conversations`;
  const conversationRoot = `${conversationsRoot}/${scopeDirectory}`;
  const configurationRoot = `${conversationRoot}/agents/${definition.packageId}`;
  return Object.freeze({
    ...base,
    configScope: assertRuntimeIdentifier(configScope || "default", "configScope"),
    scopeDirectory,
    conversationsRoot,
    conversationRoot,
    configurationRoot,
    configurationFile: `${configurationRoot}/config.json`,
  });
}

export function assertEasyWorkSkillPaths(skills, skillsRoot) {
  const root = `${path.posix.normalize(String(skillsRoot || ""))}/`;
  return (Array.isArray(skills) ? skills : []).map((skill) => {
    const remotePath = path.posix.normalize(String(skill?.remotePath || ""));
    invariant(remotePath.startsWith(root), "AGENT_SKILL_PATH_FORBIDDEN", "Agent Skill 必须来自当前 .easywork 对话 Skill 目录", {
      status: 409,
      details: { skillId: skill?.skillId || null },
    });
    return Object.freeze({
      skillId: assertRuntimeIdentifier(skill?.skillId, "skillId"),
      version: String(skill?.version || ""),
      remotePath,
      sha256: String(skill?.sha256 || "").toLowerCase(),
      ...(skill?.entrypoint ? { entrypoint: String(skill.entrypoint) } : {}),
      ...(skill?.nativeName ? { nativeName: String(skill.nativeName) } : {}),
      ...(skill?.viewHash ? { viewHash: String(skill.viewHash) } : {}),
    });
  });
}

export function runtimeEnvironment(paths, extra = {}) {
  invariant(paths?.runtimeHome && paths?.runtimeConfig && paths?.runtimeData, "AGENT_RUNTIME_PATHS_REQUIRED", "缺少 Agent runtime 路径", {
    status: 500,
    expose: false,
  });
  return Object.freeze({
    HOME: paths.runtimeHome,
    XDG_CONFIG_HOME: paths.runtimeConfig,
    XDG_DATA_HOME: paths.runtimeData,
    XDG_CACHE_HOME: paths.runtimeCache,
    CODEX_HOME: `${paths.runtimeData}/codex`,
    CLAUDE_CONFIG_DIR: `${paths.runtimeData}/claude`,
    OPENCODE_CONFIG_DIR: `${paths.runtimeConfig}/opencode`,
    EASYWORK_SKILLS_DIR: paths.skillsRoot,
    ...Object.fromEntries(Object.entries(extra || {}).map(([key, value]) => [String(key), String(value)])),
  });
}

export function unsupportedCapability(agentId, operation, reason) {
  throw new ApiError("AGENT_RUNTIME_OPERATION_UNSUPPORTED", `${agentId} 无法执行 ${operation}`, {
    status: 409,
    details: { agentId, operation, reason: String(reason || "unsupported") },
  });
}

export function createRuntimeRunId(agentId, bindingId, clock = () => Date.now()) {
  const seed = `${agentId}:${bindingId}:${clock()}:${crypto.randomBytes(8).toString("hex")}`;
  return `run_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}
