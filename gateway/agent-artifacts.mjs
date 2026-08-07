import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const AGENT_APP_ROOT = path.resolve(
  process.env.EASYWORK_AGENT_APP_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent-app"),
);

export const MANAGED_AGENT_CATALOG = Object.freeze({
  opencode: Object.freeze({
    id: "opencode",
    name: "OpenCode",
    adapter: "opencode",
    binary: "opencode",
  }),
  codex: Object.freeze({
    id: "codex",
    name: "Codex",
    adapter: "codex",
    binary: "codex",
  }),
  claudecode: Object.freeze({
    id: "claudecode",
    name: "Claude Code",
    adapter: "claude",
    binary: "claude",
  }),
});

export function normalizeAgentVersion(value) {
  const source = String(value || "").trim();
  const match = source.match(/(?:^|\s|v|rust-v)(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)/i);
  return match?.[1] || source.split(/\s+/)[0] || "";
}

export function compareAgentVersions(left, right) {
  const split = (value) =>
    normalizeAgentVersion(value)
      .split(/[.+-]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av < bv ? -1 : 1;
    return String(av).localeCompare(String(bv), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }
  return 0;
}

export function remoteAgentPlatform(fields = {}) {
  const os = String(fields.os || "").toLowerCase();
  const rawArch = String(fields.arch || "").toLowerCase();
  const arch = ["x86_64", "amd64", "x64"].includes(rawArch)
    ? "x64"
    : ["aarch64", "arm64"].includes(rawArch)
      ? "arm64"
      : rawArch;
  if (os !== "linux" || !["x64", "arm64"].includes(arch)) return "";
  return `linux-${arch}${fields.musl === true || fields.musl === "1" ? "-musl" : ""}`;
}

export function managedAgentPaths(home, agentId) {
  const catalog = MANAGED_AGENT_CATALOG[agentId];
  if (!catalog) throw new Error(`未知的托管 Agent：${agentId}`);
  const root = `${home}/.easywork/agents/${agentId}`;
  const configRoot = `${root}/config`;
  const dataRoot = `${root}/data`;
  return {
    root,
    binaryPath: `${root}/bin/${catalog.binary}`,
    configRoot,
    dataRoot,
    versionPath: `${root}/VERSION`,
    manifestPath: `${root}/artifact.json`,
    opencodeConfigPath: `${configRoot}/opencode.json`,
    opencodeAuthPath: `${dataRoot}/opencode/auth.json`,
    codexHome: `${dataRoot}/codex-home`,
    codexConfigPath: `${dataRoot}/codex-home/config.toml`,
    claudeConfigDir: `${dataRoot}/claude-home`,
    claudeSettingsPath: `${configRoot}/settings.json`,
    apiKeyPath: `${configRoot}/provider.key`,
  };
}

export function managedAgentRuntimePaths(home, agentId, runtimeId) {
  const catalog = MANAGED_AGENT_CATALOG[agentId];
  if (!catalog) throw new Error(`未知的托管 Agent：${agentId}`);
  const safeRuntimeId = String(runtimeId || "default")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 96) || "default";
  const root = `${home}/.easywork/runtime/agents/${agentId}/${safeRuntimeId}`;
  const configRoot = `${root}/config`;
  const dataRoot = `${root}/data`;
  return {
    root,
    configRoot,
    dataRoot,
    opencodeConfigPath: `${configRoot}/opencode.json`,
    opencodeAuthPath: `${dataRoot}/opencode/auth.json`,
    opencodeDataHome: dataRoot,
    codexHome: `${dataRoot}/codex-home`,
    codexConfigPath: `${dataRoot}/codex-home/config.toml`,
    claudeConfigDir: `${dataRoot}/claude-home`,
    claudeSettingsPath: `${dataRoot}/claude-home/settings.json`,
    apiKeyPath: `${configRoot}/provider.key`,
  };
}

export async function readAgentArtifactManifest(root = AGENT_APP_ROOT) {
  const manifestPath = path.join(root, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (caught) {
    const error = new Error(
      `主机 Agent 安装包清单不可用，请运行 agent-app/update-agent-app.ps1：${
        caught instanceof Error ? caught.message : "读取失败"
      }`,
    );
    error.code = "AGENT_ARTIFACT_MANIFEST_UNAVAILABLE";
    throw error;
  }
  if (Number(manifest?.schemaVersion) !== 1 || !manifest?.agents) {
    throw new Error("主机 Agent 安装包清单格式无效");
  }
  return { manifest, manifestPath, root };
}

export async function resolveAgentArtifact(agentId, platform, root = AGENT_APP_ROOT) {
  const { manifest } = await readAgentArtifactManifest(root);
  const agent = manifest.agents?.[agentId];
  const artifact = agent?.artifacts?.[platform];
  if (!agent || !artifact) {
    throw new Error(`主机没有 ${agentId} 的 ${platform || "当前平台"} 安装包`);
  }
  const localPath = path.resolve(root, String(artifact.file || ""));
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!localPath.startsWith(rootPrefix)) throw new Error("Agent 安装包路径超出 agent-app");
  await access(localPath);
  return {
    agentId,
    version: normalizeAgentVersion(agent.version),
    platform,
    localPath,
    archive: String(artifact.archive || "raw"),
    sha256: String(artifact.sha256 || "").toLowerCase(),
    size: Number(artifact.size || 0),
    source: String(artifact.source || agent.source || ""),
    file: String(artifact.file || ""),
  };
}
