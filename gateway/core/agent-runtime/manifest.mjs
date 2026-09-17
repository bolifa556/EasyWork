import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";

import { invariant } from "../errors.mjs";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  assertLinuxPlatform,
  runtimeAgentDefinition,
} from "./contract.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARCHIVE_TYPES = new Set(["raw", "tar.gz"]);

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function numericParts(value) {
  const match = String(value || "").match(/\d+(?:\.\d+)*/);
  return match ? match[0].split(".").map((part) => Number(part)) : [];
}

function compareNumericVersions(left, right) {
  const a = numericParts(left);
  const b = numericParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function matchesCompatibility(selector, hostProfile, platform) {
  if (!selector || typeof selector !== "object" || !hostProfile) return false;
  if (Array.isArray(selector.platforms) && !selector.platforms.includes(platform)) return false;
  if (selector.libcFamily && String(hostProfile.libcFamily || "") !== String(selector.libcFamily)) return false;
  if (selector.libcMax && (!hostProfile.libcVersion || compareNumericVersions(hostProfile.libcVersion, selector.libcMax) > 0)) return false;
  if (selector.kernelMajorMax !== undefined) {
    const major = numericParts(hostProfile.kernel)[0];
    if (!Number.isSafeInteger(major) || major > Number(selector.kernelMajorMax)) return false;
  }
  const cpuFlags = new Set(Array.isArray(hostProfile.cpuFlags) ? hostProfile.cpuFlags.map((flag) => String(flag).toLowerCase()) : []);
  if (Array.isArray(selector.requiredCpuFlags) && selector.requiredCpuFlags.some((flag) => !cpuFlags.has(String(flag).toLowerCase()))) return false;
  if (Array.isArray(selector.missingCpuFlags) && selector.missingCpuFlags.every((flag) => cpuFlags.has(String(flag).toLowerCase()))) return false;
  return true;
}

function compatibilityReleases(agent) {
  if (!agent?.compatibility) return [];
  if (Array.isArray(agent.compatibility)) return agent.compatibility;
  return Object.entries(agent.compatibility).map(([id, release]) => ({ id, ...release }));
}

function manifestEntry(manifest, agentId, platform, { hostProfile = null } = {}) {
  const definition = runtimeAgentDefinition(agentId);
  const agent = manifest.agents?.[definition.packageId];
  const compatibility = compatibilityReleases(agent).find((release) => (
    release?.artifacts?.[platform]
    && matchesCompatibility(release.selector, hostProfile, platform)
  ));
  const release = compatibility || agent;
  const artifact = release?.artifacts?.[platform];
  invariant(agent && artifact, "AGENT_ARTIFACT_UNAVAILABLE", `主机没有 ${definition.displayName} 的 ${platform} 安装包`, {
    status: 409,
    details: { agentId, platform },
  });
  return { definition, agent, release, artifact, compatibilityId: compatibility?.id || null };
}

export class HostAgentArtifactCatalog {
  constructor({ root, manifestFile = "manifest.json" } = {}) {
    invariant(root, "AGENT_ARTIFACT_ROOT_REQUIRED", "缺少 agent-app 根目录", { status: 500, expose: false });
    this.root = path.resolve(String(root));
    this.manifestPath = path.join(this.root, manifestFile);
    this.cachedManifest = null;
  }

  async load({ refresh = false } = {}) {
    if (this.cachedManifest && !refresh) return structuredClone(this.cachedManifest);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
    } catch (error) {
      invariant(false, "AGENT_ARTIFACT_MANIFEST_INVALID", "主机 Agent 安装包清单不可用", {
        status: 500,
        expose: false,
        cause: error,
      });
    }
    invariant(Number(manifest?.schemaVersion) === AGENT_RUNTIME_SCHEMA_VERSION && manifest?.agents && typeof manifest.agents === "object", "AGENT_ARTIFACT_MANIFEST_INVALID", "主机 Agent 安装包清单格式无效", {
      status: 500,
      expose: false,
    });
    this.cachedManifest = manifest;
    return structuredClone(manifest);
  }

  async resolve(agentId, platform, { verify = true } = {}) {
    return this.#resolve(agentId, platform, { verify });
  }

  async resolveForHost(agentId, hostProfile, { verify = true } = {}) {
    const platform = assertLinuxPlatform(hostProfile?.platform);
    return this.#resolve(agentId, platform, { verify, hostProfile });
  }

  async #resolve(agentId, platform, { verify = true, hostProfile = null } = {}) {
    const normalizedPlatform = assertLinuxPlatform(platform);
    const manifest = await this.load({ refresh: true });
    const { definition, agent, release, artifact, compatibilityId } = manifestEntry(manifest, agentId, normalizedPlatform, { hostProfile });
    invariant(typeof release.version === "string" && release.version.trim(), "AGENT_ARTIFACT_VERSION_INVALID", "Agent 安装包清单缺少版本号", {
      status: 500,
      expose: false,
    });
    const relativeFile = String(artifact.file || "");
    const localPath = path.resolve(this.root, relativeFile);
    const rootPrefix = `${this.root}${path.sep}`;
    invariant(localPath.startsWith(rootPrefix), "AGENT_ARTIFACT_PATH_FORBIDDEN", "Agent 安装包路径超出 agent-app", {
      status: 500,
      expose: false,
    });
    invariant(ARCHIVE_TYPES.has(String(artifact.archive)), "AGENT_ARTIFACT_ARCHIVE_UNSUPPORTED", "Agent 安装包压缩格式无效", {
      status: 500,
      expose: false,
    });
    const archiveBinary = String(artifact.binary || "");
    if (String(artifact.archive) === "tar.gz") {
      invariant(
        archiveBinary.length > 0 && archiveBinary === path.posix.basename(archiveBinary),
        "AGENT_ARTIFACT_BINARY_INVALID",
        "Agent 安装包清单缺少压缩包内的可执行文件名",
        { status: 500, expose: false },
      );
    }
    const expectedHash = String(artifact.sha256 || "").toLowerCase();
    invariant(SHA256_PATTERN.test(expectedHash), "AGENT_ARTIFACT_HASH_INVALID", "Agent 安装包清单缺少有效 SHA-256", {
      status: 500,
      expose: false,
    });
    await access(localPath);
    const fileStat = await stat(localPath);
    invariant(fileStat.isFile(), "AGENT_ARTIFACT_NOT_FILE", "Agent 安装包不是文件", { status: 500, expose: false });
    const declaredSize = Number(artifact.size);
    invariant(Number.isSafeInteger(declaredSize) && declaredSize === fileStat.size, "AGENT_ARTIFACT_SIZE_MISMATCH", "Agent 安装包大小与清单不一致", {
      status: 500,
      expose: false,
    });
    if (verify) {
      const actualHash = await sha256File(localPath);
      invariant(actualHash === expectedHash, "AGENT_ARTIFACT_HASH_MISMATCH", "Agent 安装包 SHA-256 校验失败", {
        status: 500,
        expose: false,
      });
    }
    return Object.freeze({
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      agentId: definition.id,
      packageId: definition.packageId,
      displayName: definition.displayName,
      binary: definition.binary,
      version: String(release.version || ""),
      platform: normalizedPlatform,
      compatibilityId,
      archive: String(artifact.archive),
      archiveBinary: archiveBinary || definition.binary,
      sha256: expectedHash,
      size: fileStat.size,
      localPath,
      source: String(artifact.source || release.source || agent.source || ""),
    });
  }
}

export { sha256File };
