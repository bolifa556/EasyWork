import crypto from "node:crypto";
import path from "node:path";

import { ApiError, invariant } from "../errors.mjs";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  normalizeLinuxPlatform,
  remoteAgentPaths,
  runtimeAgentDefinition,
} from "./contract.mjs";
import { shellQuote } from "./ssh-executor.mjs";

const DEPLOY_SCRIPT = `#!/bin/sh
set -eu
artifact="$1"
expected_hash="$2"
archive="$3"
source_binary="$4"
binary="$5"
root="$6"
release_name="$7"
release="$root/releases/$release_name"
stage="$root/.stage-$release_name-$$"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT HUP INT TERM
actual_hash="$(sha256sum "$artifact" | awk '{print $1}')"
[ "$actual_hash" = "$expected_hash" ] || { echo "artifact hash mismatch" >&2; exit 42; }
mkdir -p "$root/releases" "$stage/source" "$stage/bin"
case "$archive" in
  raw) cp "$artifact" "$stage/bin/$binary" ;;
  tar.gz)
    tar -xzf "$artifact" -C "$stage/source"
    candidate="$(find "$stage/source" -type f -name "$source_binary" -print -quit)"
    [ -n "$candidate" ] || { echo "agent binary missing from archive" >&2; exit 43; }
    cp "$candidate" "$stage/bin/$binary"
    ;;
  *) echo "unsupported archive" >&2; exit 44 ;;
esac
chmod 0700 "$stage/bin/$binary"
if [ ! -d "$release" ]; then mv "$stage" "$release"; fi
next="$root/.current-$release_name-$$"
ln -s "releases/$release_name" "$next"
mv -Tf "$next" "$root/current"
for old in "$root"/releases/*; do
  [ "$old" = "$release" ] || rm -rf "$old"
done
trap - EXIT HUP INT TERM
rm -rf "$stage"
`;

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function notFound(error) {
  return ["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code) || /no such file/i.test(String(error?.message || ""));
}

function registryPath(paths, agentId) {
  return `${paths.registryRoot}/${agentId}.json`;
}

function validateUserRoot(home, root) {
  const normalized = path.posix.normalize(String(root || ""));
  invariant(normalized.startsWith("/") && normalized !== "/" && !normalized.startsWith(`${home}/.easywork/agents/`), "AGENT_USER_ROOT_INVALID", "用户部署 Agent 目录无效", {
    status: 400,
  });
  return normalized.replace(/\/$/, "");
}

export function createInstallDescriptor({ artifact, paths, action = "install" }) {
  invariant(["install", "update"].includes(action), "AGENT_DEPLOYMENT_ACTION_INVALID", "Agent deployment action 无效", { status: 400 });
  const releaseName = `${artifact.version}-${artifact.sha256.slice(0, 16)}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const artifactDirectory = `${paths.runtimeReleases}/${artifact.sha256}`;
  return Object.freeze({
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    action,
    agentId: artifact.agentId,
    packageId: artifact.packageId,
    version: artifact.version,
    platform: artifact.platform,
    sha256: artifact.sha256,
    archive: artifact.archive,
    archiveBinary: artifact.archiveBinary,
    localArtifact: artifact.localPath,
    remoteArtifact: `${artifactDirectory}/artifact.${artifact.archive === "raw" ? "bin" : "tar.gz"}`,
    remoteReleaseDirectory: artifactDirectory,
    managedRoot: paths.managedRoot,
    releaseName,
    binaryPath: `${paths.managedRoot}/current/bin/${artifact.binary}`,
  });
}

export function createUninstallDescriptor({ agentId, paths, source = "managed" }) {
  invariant(["managed", "user"].includes(source), "AGENT_DEPLOYMENT_SOURCE_INVALID", "Agent deployment source 无效", { status: 400 });
  return Object.freeze({
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    action: "uninstall",
    agentId,
    source,
    target: source === "managed" ? paths.managedRoot : registryPath(paths, agentId),
  });
}

export class AgentDeploymentService {
  constructor({ catalog, executor, clock = () => new Date() } = {}) {
    invariant(catalog && typeof catalog.resolve === "function", "AGENT_CATALOG_REQUIRED", "缺少 Agent artifact catalog", {
      status: 500,
      expose: false,
    });
    invariant(executor && typeof executor.home === "function" && typeof executor.exec === "function", "AGENT_EXECUTOR_REQUIRED", "缺少 Agent remote executor", {
      status: 500,
      expose: false,
    });
    this.catalog = catalog;
    this.executor = executor;
    this.clock = clock;
  }

  async detectPlatform() {
    const result = await this.executor.exec("uname -s; uname -m; (ldd --version 2>&1 || true) | head -n 1", { maxOutputBytes: 64 * 1024 });
    invariant(result.code === 0, "AGENT_PLATFORM_DETECTION_FAILED", "无法检测远端 Agent 平台", { status: 502 });
    const [os, arch, libc = ""] = String(result.stdout).split(/\r?\n/);
    return normalizeLinuxPlatform({ os, arch, musl: /musl/i.test(libc) });
  }

  async #paths(agentId) {
    const paths = remoteAgentPaths(await this.executor.home(), agentId);
    const guarded = [paths.easyworkRoot, `${paths.easyworkRoot}/agents`, paths.managedRoot, paths.managedReleases, `${paths.easyworkRoot}/runtime`, paths.runtimeReleases, paths.registryRoot];
    const command = `for target in ${guarded.map(shellQuote).join(" ")}; do [ ! -L "$target" ] || exit 73; done; mkdir -p ${shellQuote(paths.easyworkRoot)}; chmod 0700 ${shellQuote(paths.easyworkRoot)}`;
    const result = await this.executor.exec(command, { maxOutputBytes: 16 * 1024 });
    invariant(result.code === 0, "AGENT_EASYWORK_ROOT_UNSAFE", "远端 ~/.easywork 路径包含符号链接，已拒绝写入", { status: 409 });
    return paths;
  }

  async #readJson(remotePath) {
    try {
      return JSON.parse((await this.executor.readFile(remotePath)).toString("utf8"));
    } catch (error) {
      if (notFound(error)) return null;
      if (error instanceof SyntaxError) throw new ApiError("AGENT_REMOTE_STATE_INVALID", "远端 Agent state.json 格式无效", { status: 502 });
      throw error;
    }
  }

  async status(agentId, { source = null } = {}) {
    const definition = runtimeAgentDefinition(agentId);
    const paths = await this.#paths(agentId);
    const managed = await this.#readJson(paths.managedState);
    const user = await this.#readJson(registryPath(paths, agentId));
    const selected = source === "managed" ? managed : source === "user" ? user : managed || user;
    if (!selected) {
      return Object.freeze({
        schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
        agentId,
        displayName: definition.displayName,
        installed: false,
        managed: false,
        status: "not-installed",
        capabilities: { install: "available", update: "unavailable", uninstall: "unavailable" },
      });
    }
    invariant(Number(selected.schemaVersion) === AGENT_RUNTIME_SCHEMA_VERSION && selected.agentId === agentId && ["managed", "user"].includes(selected.source), "AGENT_REMOTE_STATE_INVALID", "远端 Agent state 与当前 Agent 不一致", {
      status: 502,
    });
    const expectedPrefix = selected.source === "managed" ? `${paths.managedRoot}/` : "/";
    invariant(String(selected.binaryPath || "").startsWith(expectedPrefix), "AGENT_REMOTE_STATE_INVALID", "远端 Agent binaryPath 无效", { status: 502 });
    const executable = await this.executor.exec(`test -x ${shellQuote(selected.binaryPath)}`, { maxOutputBytes: 16 * 1024 });
    const ready = executable.code === 0;
    return Object.freeze({
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      agentId,
      displayName: definition.displayName,
      installed: true,
      managed: selected.source === "managed",
      source: selected.source,
      status: ready ? "ready" : "broken",
      version: String(selected.version || "unknown"),
      platform: selected.platform || null,
      binaryPath: String(selected.binaryPath),
      capabilities: {
        install: "unavailable",
        update: selected.source === "managed" && ready ? "available" : "unavailable",
        uninstall: "available",
      },
    });
  }

  async checkUpdate(agentId, { platform = null } = {}) {
    const current = await this.status(agentId, { source: "managed" });
    invariant(current.installed, "AGENT_NOT_INSTALLED", `${current.displayName} 未安装`, { status: 409 });
    const artifact = await this.catalog.resolve(agentId, platform || current.platform || await this.detectPlatform(), { verify: true });
    return Object.freeze({
      agentId,
      installedVersion: current.version,
      availableVersion: artifact.version,
      updateAvailable: current.version !== artifact.version || String((await this.#readJson((await this.#paths(agentId)).managedState))?.sha256 || "") !== artifact.sha256,
      platform: artifact.platform,
      sha256: artifact.sha256,
    });
  }

  async install(agentId, { platform = null } = {}) {
    runtimeAgentDefinition(agentId);
    const detectedPlatform = platform || await this.detectPlatform();
    const artifact = await this.catalog.resolve(agentId, detectedPlatform, { verify: true });
    const paths = await this.#paths(agentId);
    const previous = await this.#readJson(paths.managedState);
    const descriptor = createInstallDescriptor({ artifact, paths, action: previous ? "update" : "install" });
    if (previous?.sha256 === descriptor.sha256 && previous?.binaryPath === descriptor.binaryPath) {
      return Object.freeze({ action: "none", changed: false, descriptor, state: previous });
    }
    const scriptHash = crypto.createHash("sha256").update(DEPLOY_SCRIPT).digest("hex");
    const scriptPath = `${paths.runtimeReleases}/scripts/${scriptHash}/deploy-agent.sh`;
    await this.executor.upload(descriptor.localArtifact, descriptor.remoteArtifact);
    await this.executor.writeAtomic(scriptPath, DEPLOY_SCRIPT, { mode: 0o700 });
    const command = [
      scriptPath,
      descriptor.remoteArtifact,
      descriptor.sha256,
      descriptor.archive,
      descriptor.archiveBinary,
      artifact.binary,
      descriptor.managedRoot,
      descriptor.releaseName,
    ].map(shellQuote).join(" ");
    const result = await this.executor.exec(command, { maxOutputBytes: 2 * 1024 * 1024 });
    invariant(result.code === 0, "AGENT_DEPLOYMENT_FAILED", `${artifact.displayName} 部署失败`, {
      status: 502,
      details: { exitCode: result.code, stderr: String(result.stderr || "").slice(0, 2_000) },
    });
    const state = {
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      agentId,
      packageId: artifact.packageId,
      source: "managed",
      managed: true,
      version: descriptor.version,
      platform: descriptor.platform,
      sha256: descriptor.sha256,
      binaryPath: descriptor.binaryPath,
      installedAt: this.clock().toISOString(),
    };
    await this.executor.writeAtomic(paths.managedState, json(state));
    return Object.freeze({ action: previous ? "update" : "install", changed: true, descriptor, state });
  }

  async registerUserDeployment(agentId, { root }) {
    const definition = runtimeAgentDefinition(agentId);
    const home = await this.executor.home();
    const paths = remoteAgentPaths(home, agentId);
    const selectedRoot = validateUserRoot(home, root);
    const binaryPath = `${selectedRoot}/bin/${definition.binary}`;
    let result = await this.executor.exec(`test -x ${shellQuote(binaryPath)} && ${shellQuote(binaryPath)} --version`, { maxOutputBytes: 64 * 1024 });
    let resolvedBinary = binaryPath;
    if (result.code !== 0) {
      resolvedBinary = `${selectedRoot}/${definition.binary}`;
      result = await this.executor.exec(`test -x ${shellQuote(resolvedBinary)} && ${shellQuote(resolvedBinary)} --version`, { maxOutputBytes: 64 * 1024 });
    }
    invariant(result.code === 0, "AGENT_USER_BINARY_INVALID", `所选目录中没有可执行的 ${definition.binary}`, { status: 409 });
    const state = {
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      agentId,
      source: "user",
      managed: false,
      root: selectedRoot,
      binaryPath: resolvedBinary,
      version: String(result.stdout || result.stderr || "unknown").trim().split(/\r?\n/)[0].slice(0, 256),
      selectedAt: this.clock().toISOString(),
    };
    await this.executor.writeAtomic(registryPath(paths, agentId), json(state));
    return Object.freeze(state);
  }

  async scan(agentId, { trigger, roots = [] } = {}) {
    const definition = runtimeAgentDefinition(agentId);
    invariant(trigger === "user", "AGENT_SCAN_TRIGGER_REQUIRED", "Agent 扫描只能由用户主动触发", { status: 409 });
    const home = await this.executor.home();
    const selectedRoots = roots.map((root) => validateUserRoot(home, root));
    invariant(selectedRoots.length > 0, "AGENT_SCAN_ROOT_REQUIRED", "Agent 扫描需要用户选择目录", { status: 400 });
    const discoveries = [];
    for (const root of selectedRoots) {
      const command = `find ${shellQuote(root)} -maxdepth 2 -type f -name ${shellQuote(definition.binary)} -perm -u+x -print 2>/dev/null | head -n 20`;
      const result = await this.executor.exec(command, { maxOutputBytes: 256 * 1024 });
      if (result.code !== 0 && result.code !== 1) continue;
      for (const binaryPath of String(result.stdout).split(/\r?\n/).filter(Boolean)) {
        discoveries.push(Object.freeze({ agentId, root, binaryPath: path.posix.normalize(binaryPath), source: "user", managed: false }));
      }
    }
    return Object.freeze(discoveries);
  }

  async uninstall(agentId, { source = "managed" } = {}) {
    runtimeAgentDefinition(agentId);
    const paths = await this.#paths(agentId);
    const descriptor = createUninstallDescriptor({ agentId, paths, source });
    const allowedRoot = `${paths.easyworkRoot}/`;
    invariant(descriptor.target.startsWith(allowedRoot), "AGENT_UNINSTALL_PATH_FORBIDDEN", "Agent 卸载路径越界", { status: 500, expose: false });
    const command = source === "managed"
      ? `rm -rf -- ${shellQuote(paths.managedRoot)} ${shellQuote(`${paths.easyworkRoot}/runtime/agents/${agentId}`)}`
      : `rm -f -- ${shellQuote(registryPath(paths, agentId))}`;
    const result = await this.executor.exec(command, { maxOutputBytes: 64 * 1024 });
    invariant(result.code === 0, "AGENT_UNINSTALL_FAILED", "Agent 卸载失败", { status: 502 });
    return Object.freeze({ action: "uninstall", changed: true, descriptor });
  }

  async resolveRuntime(agentId, { source = null } = {}) {
    const status = await this.status(agentId, { source });
    invariant(status.installed, "AGENT_NOT_INSTALLED", `${status.displayName} 未安装`, {
      status: 409,
      details: { agentId },
    });
    return status;
  }
}

export { DEPLOY_SCRIPT };
