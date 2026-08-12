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

function manifestEntry(manifest, agentId, platform) {
  const definition = runtimeAgentDefinition(agentId);
  const agent = manifest.agents?.[definition.packageId];
  const artifact = agent?.artifacts?.[platform];
  invariant(agent && artifact, "AGENT_ARTIFACT_UNAVAILABLE", `主机没有 ${definition.displayName} 的 ${platform} 安装包`, {
    status: 409,
    details: { agentId, platform },
  });
  return { definition, agent, artifact };
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
    const normalizedPlatform = assertLinuxPlatform(platform);
    const manifest = await this.load({ refresh: true });
    const { definition, agent, artifact } = manifestEntry(manifest, agentId, normalizedPlatform);
    invariant(typeof agent.version === "string" && agent.version.trim(), "AGENT_ARTIFACT_VERSION_INVALID", "Agent 安装包清单缺少版本号", {
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
      version: String(agent.version || ""),
      platform: normalizedPlatform,
      archive: String(artifact.archive),
      archiveBinary: archiveBinary || definition.binary,
      sha256: expectedHash,
      size: fileStat.size,
      localPath,
      source: String(artifact.source || agent.source || ""),
    });
  }
}

export { sha256File };
