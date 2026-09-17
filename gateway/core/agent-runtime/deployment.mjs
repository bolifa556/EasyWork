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
const STATUS_CACHE_TTL_MS = 5 * 60_000;
const AUTH_STATUS_CACHE_TTL_MS = 2_000;
const LOGIN_URL_TIMEOUT_MS = 30_000;
const QODER_CATALOG_CACHE_TTL_MS = 30_000;
const QODER_CONTROL_TIMEOUT_MS = 30_000;
const QODER_INITIALIZE_TIMEOUT_MS = 120_000;
const QODER_SDK_VERSION = "1.0.41";
const LOGIN_URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

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

function qoderControlRequest(request) {
  return {
    type: "control_request",
    request_id: `easywork-qoder-catalog-${crypto.randomBytes(12).toString("hex")}`,
    request,
  };
}

function qoderControlBody(frame) {
  const body = frame?.response?.response;
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function cleanText(value, limit = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

async function waitAtMost(promise, timeoutMs) {
  let timer;
  await Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

function normalizeQoderPromotion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const localized = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const entries = Object.entries(input)
      .flatMap(([locale, text]) => cleanText(text, 200) ? [[cleanText(locale, 32), cleanText(text, 200)]] : [])
      .slice(0, 12);
    return entries.length ? Object.fromEntries(entries) : null;
  };
  const badge = localized(value.badge);
  const description = localized(value.description);
  const discountFactor = finiteNumber(value.discount_factor);
  const originalPriceFactor = finiteNumber(value.before_promotion_price_factor);
  return {
    active: value.active === true,
    ...(badge ? { badge } : {}),
    ...(description ? { description } : {}),
    ...(discountFactor !== null ? { discountFactor } : {}),
    ...(originalPriceFactor !== null ? { originalPriceFactor } : {}),
    ...(cleanText(value.window_start, 16) ? { windowStart: cleanText(value.window_start, 16) } : {}),
    ...(cleanText(value.window_end, 16) ? { windowEnd: cleanText(value.window_end, 16) } : {}),
    ...(cleanText(value.timezone, 64) ? { timezone: cleanText(value.timezone, 64) } : {}),
  };
}

function normalizeQoderModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.isEnabled === false) return null;
  const id = cleanText(value.value || value.modelId, 512);
  if (!id) return null;
  const contextTiers = [];
  if (value.context_config && typeof value.context_config === "object" && !Array.isArray(value.context_config)) {
    for (const [label, entry] of Object.entries(value.context_config)) {
      const tokens = positiveInteger(entry?.token_count);
      if (tokens) contextTiers.push({ label: cleanText(label, 64) || formatContextWindow(tokens), tokens, isDefault: entry?.is_default === true });
    }
  }
  for (const tokens of Array.isArray(value.availableContextWindows) ? value.availableContextWindows : []) {
    const normalized = positiveInteger(tokens);
    if (normalized && !contextTiers.some((entry) => entry.tokens === normalized)) contextTiers.push({ label: formatContextWindow(normalized), tokens: normalized, isDefault: false });
  }
  contextTiers.sort((left, right) => left.tokens - right.tokens);
  const declaredDefault = positiveInteger(value.defaultContextWindow);
  const defaultContextWindow = declaredDefault
    || contextTiers.find((entry) => entry.isDefault)?.tokens
    || contextTiers[0]?.tokens
    || null;
  const effortEntries = value.thinking_config?.enabled?.efforts;
  const efforts = [...new Set([
    ...(Array.isArray(value.efforts) ? value.efforts : []),
    ...(effortEntries && typeof effortEntries === "object" && !Array.isArray(effortEntries) ? Object.keys(effortEntries) : []),
  ].map((entry) => cleanText(entry, 64)).filter(Boolean))].slice(0, 24);
  const priceFactor = finiteNumber(value.priceFactor ?? value.serverModel?.price_factor);
  const originalPriceFactor = finiteNumber(value.originalPriceFactor ?? value.serverModel?.before_promotion_price_factor);
  const promotion = normalizeQoderPromotion(value.promotion);
  return {
    id,
    name: cleanText(value.displayName, 256) || id,
    description: cleanText(value.description),
    source: cleanText(value.source, 64) || null,
    isDefault: value.isDefault === true,
    isNew: value.isNew === true,
    isFree: value.isFree === true,
    priceFactor,
    originalPriceFactor,
    contextTiers,
    defaultContextWindow,
    efforts,
    defaultEffort: cleanText(value.defaultEffort, 64) || Object.entries(effortEntries || {}).find(([, entry]) => entry?.is_default === true)?.[0] || null,
    promotion,
  };
}

function formatContextWindow(tokens) {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

function normalizeQoderQuota(value, { organization = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Qoder uses `available: false` together with negative sentinel values (for
  // example cap=-1) when the signed-in account has no organization resource
  // package.  It is not a real zero-credit package and must stay out of the UI.
  if (organization && value.available !== true) return null;
  const quotaNumber = (entry) => {
    const number = finiteNumber(entry);
    return number !== null && number >= 0 ? number : null;
  };
  const total = quotaNumber(organization ? value.cap : value.total);
  const used = quotaNumber(value.used);
  const remaining = quotaNumber(value.remaining);
  const percentage = quotaNumber(value.percentage);
  const unit = cleanText(value.unit, 64) || null;
  if ([total, used, remaining, percentage].every((entry) => entry === null) && !unit) return null;
  return {
    total,
    used,
    remaining,
    percentage,
    unit,
    ...(organization ? { available: value.available === true } : {}),
  };
}

function normalizeQoderUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const userQuota = normalizeQoderQuota(value.userQuota);
  const addOnQuota = normalizeQoderQuota(value.addOnQuota);
  const orgResourcePackage = normalizeQoderQuota(value.orgResourcePackage, { organization: true });
  const totalUsagePercentage = finiteNumber(value.totalUsagePercentage);
  const expiresAt = finiteNumber(value.expiresAt);
  if (!userQuota && !addOnQuota && !orgResourcePackage && totalUsagePercentage === null && expiresAt === null) return null;
  return {
    userQuota,
    addOnQuota,
    orgResourcePackage,
    totalUsagePercentage,
    expiresAt,
    isQuotaExceeded: value.isQuotaExceeded === true,
  };
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
    compatibilityId: artifact.compatibilityId || null,
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
    this.statusCache = new Map();
    this.statusPending = new Map();
    this.runtimeCache = new Map();
    this.runtimePending = new Map();
    this.pathsCache = new Map();
    this.hostProfilePromise = null;
    this.authenticationCache = new Map();
    this.authenticationPending = new Map();
    this.loginProcesses = new Map();
    this.nativeCatalogCache = new Map();
    this.nativeCatalogPending = new Map();
  }

  async detectHostProfile() {
    if (this.hostProfilePromise) return structuredClone(await this.hostProfilePromise);
    this.hostProfilePromise = (async () => {
      const result = await this.executor.exec("uname -s; uname -m; (ldd --version 2>&1 || true) | head -n 1; uname -r; (sed -n 's/^flags[[:space:]]*:[[:space:]]*//p; s/^Features[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null || true) | head -n 1", { maxOutputBytes: 64 * 1024 });
      invariant(result.code === 0, "AGENT_PLATFORM_DETECTION_FAILED", "无法检测远端 Agent 平台", { status: 502 });
      const [os, arch, libc = "", kernel = "", cpuFlags = ""] = String(result.stdout).split(/\r?\n/);
      const musl = /musl/i.test(libc);
      const libcMatch = String(libc).match(/(?:glibc|gnu libc|libc\)?)[^0-9]*([0-9]+(?:\.[0-9]+)+)/i)
        || String(libc).match(/([0-9]+(?:\.[0-9]+)+)/);
      return Object.freeze({
        platform: normalizeLinuxPlatform({ os, arch, musl }),
        os: String(os || ""),
        arch: String(arch || ""),
        libcFamily: musl ? "musl" : "glibc",
        libcVersion: libcMatch?.[1] || null,
        kernel: String(kernel || ""),
        cpuFlags: [...new Set(String(cpuFlags || "").trim().toLowerCase().split(/\s+/).filter(Boolean))],
      });
    })().catch((error) => {
      this.hostProfilePromise = null;
      throw error;
    });
    return structuredClone(await this.hostProfilePromise);
  }

  async detectPlatform() {
    return (await this.detectHostProfile()).platform;
  }

  async #resolveArtifact(agentId, { platform = null, verify = true } = {}) {
    const profile = await this.detectHostProfile();
    const selected = Object.freeze({ ...profile, platform: platform || profile.platform });
    if (typeof this.catalog.resolveForHost === "function") {
      return this.catalog.resolveForHost(agentId, selected, { verify });
    }
    return this.catalog.resolve(agentId, selected.platform, { verify });
  }

  async #paths(agentId) {
    const key = String(agentId);
    if (this.pathsCache.has(key)) return this.pathsCache.get(key);
    const pending = (async () => {
      const paths = remoteAgentPaths(await this.executor.home(), agentId);
      const guarded = [paths.easyworkRoot, `${paths.easyworkRoot}/agents`, paths.managedRoot, paths.managedReleases, `${paths.easyworkRoot}/runtime`, paths.runtimeReleases, paths.registryRoot];
      const command = `for target in ${guarded.map(shellQuote).join(" ")}; do [ ! -L "$target" ] || exit 73; done; mkdir -p ${shellQuote(paths.easyworkRoot)}; chmod 0700 ${shellQuote(paths.easyworkRoot)}`;
      const result = await this.executor.exec(command, { maxOutputBytes: 16 * 1024 });
      invariant(result.code === 0, "AGENT_EASYWORK_ROOT_UNSAFE", "远端 ~/.easywork 路径包含符号链接，已拒绝写入", { status: 409 });
      return paths;
    })();
    this.pathsCache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.pathsCache.get(key) === pending) this.pathsCache.delete(key);
      throw error;
    }
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
    const cacheKey = `${agentId}:${source || "auto"}`;
    const now = new Date(this.clock()).valueOf();
    const cached = this.statusCache.get(cacheKey);
    if (cached && now - cached.checkedAt < STATUS_CACHE_TTL_MS) return structuredClone(cached.value);
    if (this.statusPending.has(cacheKey)) return structuredClone(await this.statusPending.get(cacheKey));
    const pending = this.#inspectStatus(agentId, source).then((value) => {
      const entry = { checkedAt: now, value };
      this.statusCache.set(cacheKey, entry);
      if (!source && value.source) this.statusCache.set(`${agentId}:${value.source}`, entry);
      return value;
    }).finally(() => this.statusPending.delete(cacheKey));
    this.statusPending.set(cacheKey, pending);
    return structuredClone(await pending);
  }

  async #inspectStatus(agentId, source) {
    const definition = runtimeAgentDefinition(agentId);
    const paths = await this.#paths(agentId);
    const [managed, user] = await Promise.all([
      this.#readJson(paths.managedState),
      this.#readJson(registryPath(paths, agentId)),
    ]);
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
      compatibilityId: selected.compatibilityId || null,
      binaryPath: String(selected.binaryPath),
      capabilities: {
        install: "unavailable",
        update: selected.source === "managed" && ready ? "available" : "unavailable",
        uninstall: "available",
      },
    });
  }

  #invalidateStatus(agentId) {
    const prefix = `${agentId}:`;
    for (const key of this.statusCache.keys()) if (key.startsWith(prefix)) this.statusCache.delete(key);
    for (const key of this.statusPending.keys()) if (key.startsWith(prefix)) this.statusPending.delete(key);
    for (const key of this.runtimeCache.keys()) if (key.startsWith(prefix)) this.runtimeCache.delete(key);
    this.authenticationCache.delete(String(agentId));
    this.authenticationPending.delete(String(agentId));
    this.nativeCatalogCache.delete(String(agentId));
    this.nativeCatalogPending.delete(String(agentId));
  }

  async authenticationStatus(agentId, { force = false } = {}) {
    const definition = runtimeAgentDefinition(agentId);
    invariant(agentId === "qoder-cn", "AGENT_AUTHENTICATION_UNSUPPORTED", `${definition.displayName} 不使用网页登录`, { status: 409 });
    const now = new Date(this.clock()).valueOf();
    const cached = this.authenticationCache.get(agentId);
    if (!force && cached && now - cached.checkedAt < AUTH_STATUS_CACHE_TTL_MS) return structuredClone(cached.value);
    if (!force && this.authenticationPending.has(agentId)) return structuredClone(await this.authenticationPending.get(agentId));
    const pending = (async () => {
      const installation = await this.status(agentId);
      if (!installation.installed || installation.status !== "ready") {
        return Object.freeze({ required: true, authenticated: false, status: "unavailable", loginAvailable: false, message: "请先部署 Qoder CN" });
      }
      const paths = await this.#paths(agentId);
      const prepared = await this.executor.exec(`for target in ${[paths.accountsRoot, paths.accountRoot, paths.accountAuthRoot].map(shellQuote).join(" ")}; do [ ! -L \"$target\" ] || exit 73; done; mkdir -p -- ${shellQuote(paths.accountAuthRoot)}; chmod 0700 ${shellQuote(paths.accountsRoot)} ${shellQuote(paths.accountRoot)} ${shellQuote(paths.accountAuthRoot)}`, { maxOutputBytes: 16 * 1024 });
      invariant(prepared.code === 0, "AGENT_AUTH_ROOT_UNSAFE", "Qoder CN 登录目录不可用", { status: 409 });
      const command = `QODERCN_CONFIG_DIR=${shellQuote(paths.accountRoot)} NO_BROWSER=1 ${shellQuote(installation.binaryPath)} status -o json`;
      const result = await this.executor.exec(command, { maxOutputBytes: 64 * 1024 });
      let document = null;
      try { document = JSON.parse(String(result.stdout || "").trim()); } catch { /* typed status below */ }
      const authenticated = result.code === 0 && document?.logged_in === true;
      return Object.freeze({
        required: true,
        authenticated,
        status: authenticated ? "authenticated" : "unauthenticated",
        loginAvailable: true,
        version: String(document?.version || installation.version || "unknown"),
        ...(authenticated ? {} : { message: "请登录 Qoder CN 账号" }),
      });
    })().then((value) => {
      this.authenticationCache.set(agentId, { checkedAt: now, value });
      return value;
    }).finally(() => this.authenticationPending.delete(agentId));
    this.authenticationPending.set(agentId, pending);
    return structuredClone(await pending);
  }

  async beginLogin(agentId) {
    const definition = runtimeAgentDefinition(agentId);
    invariant(agentId === "qoder-cn", "AGENT_AUTHENTICATION_UNSUPPORTED", `${definition.displayName} 不使用网页登录`, { status: 409 });
    const current = await this.authenticationStatus(agentId, { force: true });
    if (current.authenticated) return Object.freeze({ ...current, url: null, started: false });
    const existing = this.loginProcesses.get(agentId);
    if (existing?.process && !existing.process.closed) return existing.result;
    const [installation, paths] = await Promise.all([this.resolveRuntime(agentId), this.#paths(agentId)]);
    let stderr = "";
    const process = await this.executor.spawn({
      executable: installation.binaryPath,
      args: ["login"],
      cwd: paths.accountRoot,
      env: { HOME: paths.accountRoot, QODERCN_CONFIG_DIR: paths.accountRoot, BROWSER: "www-browser", NO_BROWSER: "1" },
      onStderr: (chunk) => { stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-16_384); },
    });
    const readUrl = (async () => {
      const lines = process.lines();
      const iterator = lines[Symbol.asyncIterator]();
      const deadline = Date.now() + LOGIN_URL_TIMEOUT_MS;
      try {
        while (Date.now() < deadline) {
          const remaining = Math.max(1, deadline - Date.now());
          let timeout;
          const next = await Promise.race([
            iterator.next(),
            new Promise((resolve) => { timeout = setTimeout(() => resolve({ timeout: true }), remaining); }),
          ]).finally(() => clearTimeout(timeout));
          if (next?.timeout || next.done) break;
          const url = String(next.value || "").match(LOGIN_URL_PATTERN)?.[0]?.replace(/[),.;]+$/, "");
          if (url) return url;
        }
      } finally { await iterator.return?.(); }
      throw new ApiError("QODER_LOGIN_URL_UNAVAILABLE", "Qoder CN 未返回网页登录地址", {
        status: 502,
        retryable: true,
        details: { stderr: stderr.slice(-2_000) },
      });
    })();
    const result = readUrl.then((url) => Object.freeze({ required: true, authenticated: false, status: "pending", loginAvailable: true, started: true, url }));
    this.loginProcesses.set(agentId, { process, result });
    process.wait().finally(() => {
      if (this.loginProcesses.get(agentId)?.process === process) this.loginProcesses.delete(agentId);
      this.authenticationCache.delete(agentId);
    }).catch(() => undefined);
    try { return await result; }
    catch (error) {
      if (!process.closed) await process.signal("SIGTERM").catch(() => undefined);
      if (this.loginProcesses.get(agentId)?.process === process) this.loginProcesses.delete(agentId);
      throw error;
    }
  }

  async nativeCatalog(agentId, { force = false } = {}) {
    const definition = runtimeAgentDefinition(agentId);
    invariant(agentId === "qoder-cn", "AGENT_NATIVE_CATALOG_UNSUPPORTED", `${definition.displayName} 不提供原生模型目录`, { status: 409 });
    const now = new Date(this.clock()).valueOf();
    const cached = this.nativeCatalogCache.get(agentId);
    if (!force && cached && now - cached.checkedAt < QODER_CATALOG_CACHE_TTL_MS) return structuredClone(cached.value);
    if (this.nativeCatalogPending.has(agentId)) return structuredClone(await this.nativeCatalogPending.get(agentId));
    const pending = this.#probeQoderCatalog(agentId).then((value) => {
      this.nativeCatalogCache.set(agentId, { checkedAt: now, value });
      return value;
    }).finally(() => this.nativeCatalogPending.delete(agentId));
    this.nativeCatalogPending.set(agentId, pending);
    return structuredClone(await pending);
  }

  async #probeQoderCatalog(agentId) {
    const authentication = await this.authenticationStatus(agentId, { force: true });
    invariant(authentication.authenticated, "QODER_LOGIN_REQUIRED", "请先登录 Qoder CN 账号", { status: 409, retryable: true });
    const [installation, paths] = await Promise.all([this.status(agentId), this.#paths(agentId)]);
    invariant(installation.installed && installation.status === "ready", "AGENT_RUNTIME_NOT_READY", "Qoder CN 运行时不可用", { status: 409 });
    const authPayloadPath = `${paths.accountRoot}/.easywork-sdk-auth-${crypto.randomBytes(12).toString("hex")}.json`;
    await this.executor.writeAtomic(authPayloadPath, json({ type: "qodercli" }), { mode: 0o600 });
    let stderr = "";
    let diagnostics = "";
    let process = null;
    try {
      process = await this.executor.spawn({
        executable: installation.binaryPath,
        args: ["--print", "--output-format", "stream-json", "--input-format", "stream-json", "--no-session-persistence", "--tools", "", "--disable-builtin-skills"],
        cwd: paths.accountRoot,
        env: {
          HOME: paths.accountRoot,
          QODERCN_CONFIG_DIR: paths.accountRoot,
          QODER_AGENT_SDK_ENTRYPOINT: "sdk-ts",
          QODER_AGENT_SDK_VERSION: QODER_SDK_VERSION,
          QODER_SDK_AUTH_PAYLOAD_FILE: authPayloadPath,
          NO_BROWSER: "1",
        },
        onStderr: (chunk) => { stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-16_384); },
      });
      const lineTask = (async () => {
        try {
          for await (const line of process.lines()) {
            let frame = null;
            try { frame = JSON.parse(String(line)); } catch { /* retain plain diagnostic text */ }
            const errors = Array.isArray(frame?.errors) ? frame.errors.filter((entry) => typeof entry === "string") : [];
            const text = errors.length ? errors.join("\n") : frame?.type === "result" && frame?.is_error ? cleanText(frame.result, 2_000) : "";
            if (text) diagnostics = `${diagnostics}\n${text}`.slice(-8_000);
          }
        } catch { /* requestControl owns typed transport failures */ }
      })();
      const initialize = qoderControlBody(await process.requestControl(qoderControlRequest({
        type: "initialize",
        modelPolicyProvider: false,
        supportsCatalogReadyInitialize: true,
        supportsAvailableModelsUpdate: true,
        supportsCommandsChanged: true,
        initializeTimeoutMs: QODER_INITIALIZE_TIMEOUT_MS,
      }), QODER_INITIALIZE_TIMEOUT_MS));
      let rawModels = [];
      try {
        rawModels = qoderControlBody(await process.requestControl(qoderControlRequest({ subtype: "get_models", fetchStrategy: "live" }), QODER_CONTROL_TIMEOUT_MS)).models || [];
      } catch {
        rawModels = Array.isArray(initialize.models) ? initialize.models : [];
      }
      if (!Array.isArray(rawModels) || rawModels.length === 0) {
        try {
          rawModels = qoderControlBody(await process.requestControl(qoderControlRequest({ subtype: "get_models", fetchStrategy: "cache" }), QODER_CONTROL_TIMEOUT_MS)).models || [];
        } catch { rawModels = []; }
      }
      let usage = null;
      let usageError = null;
      try {
        const usageResponse = qoderControlBody(await process.requestControl(qoderControlRequest({ type: "get_usage_info" }), QODER_CONTROL_TIMEOUT_MS));
        usage = normalizeQoderUsage(usageResponse.usage);
        usageError = cleanText(usageResponse.usage_error, 1_000) || null;
      } catch (error) {
        usageError = cleanText(error?.message, 1_000) || "Qoder CN 未返回积分信息";
      }
      const models = rawModels.slice(0, 256).map(normalizeQoderModel).filter(Boolean);
      process.endInput();
      await waitAtMost(process.wait().catch(() => undefined), 1_000);
      if (!process.closed) await process.signal("SIGTERM").catch(() => undefined);
      await waitAtMost(lineTask.catch(() => undefined), 250);
      return Object.freeze({
        agentId,
        models,
        usage,
        usageError,
        fetchedAt: this.clock().toISOString(),
      });
    } catch (error) {
      if (process && !process.closed) await process.signal("SIGTERM").catch(() => undefined);
      throw new ApiError("QODER_NATIVE_CATALOG_FAILED", "Qoder CN 原生模型目录读取失败", {
        status: 502,
        retryable: true,
        details: { reason: cleanText(error?.message, 1_000), diagnostics: `${diagnostics}\n${stderr}`.trim().slice(-2_000) },
      });
    } finally {
      await this.executor.exec(`rm -f -- ${shellQuote(authPayloadPath)}`, { maxOutputBytes: 16 * 1024 }).catch(() => undefined);
    }
  }

  async checkUpdate(agentId, { platform = null } = {}) {
    const current = await this.status(agentId, { source: "managed" });
    invariant(current.installed, "AGENT_NOT_INSTALLED", `${current.displayName} 未安装`, { status: 409 });
    const artifact = await this.#resolveArtifact(agentId, { platform: platform || current.platform, verify: true });
    return Object.freeze({
      agentId,
      installedVersion: current.version,
      availableVersion: artifact.version,
      updateAvailable: current.version !== artifact.version || String((await this.#readJson((await this.#paths(agentId)).managedState))?.sha256 || "") !== artifact.sha256,
      platform: artifact.platform,
      sha256: artifact.sha256,
    });
  }

  async install(agentId, { platform = null, force = false } = {}) {
    runtimeAgentDefinition(agentId);
    const detectedPlatform = platform || await this.detectPlatform();
    const artifact = await this.#resolveArtifact(agentId, { platform: detectedPlatform, verify: true });
    const paths = await this.#paths(agentId);
    const previous = await this.#readJson(paths.managedState);
    const descriptor = createInstallDescriptor({ artifact, paths, action: previous ? "update" : "install" });
    if (!force && previous?.sha256 === descriptor.sha256 && previous?.binaryPath === descriptor.binaryPath) {
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
      compatibilityId: descriptor.compatibilityId,
      sha256: descriptor.sha256,
      binaryPath: descriptor.binaryPath,
      installedAt: this.clock().toISOString(),
    };
    await this.executor.writeAtomic(paths.managedState, json(state));
    this.#invalidateStatus(agentId);
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
    const reportedVersion = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0].slice(0, 256);
    const state = {
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      agentId,
      source: "user",
      managed: false,
      root: selectedRoot,
      binaryPath: resolvedBinary,
      version: reportedVersion || "unknown",
      selectedAt: this.clock().toISOString(),
    };
    await this.executor.writeAtomic(registryPath(paths, agentId), json(state));
    this.#invalidateStatus(agentId);
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
    this.#invalidateStatus(agentId);
    return Object.freeze({ action: "uninstall", changed: true, descriptor });
  }

  async resolveRuntime(agentId, { source = null } = {}) {
    const key = `${agentId}:${source || "auto"}`;
    const now = new Date(this.clock()).valueOf();
    const cached = this.runtimeCache.get(key);
    if (cached && now - cached.checkedAt < STATUS_CACHE_TTL_MS) return structuredClone(cached.value);
    if (this.runtimePending.has(key)) return structuredClone(await this.runtimePending.get(key));

    const pending = (async () => {
      let status = await this.status(agentId, { source });
      invariant(status.installed, "AGENT_NOT_INSTALLED", `${status.displayName} 未安装`, {
        status: 409,
        details: { agentId },
      });

      // A managed binding always runs the artifact selected by the current
      // manifest and host profile. This is normally the primary release, or a
      // pinned compatibility release when the host selector matches. Any stale
      // deployment is replaced before a native session can be opened.
      if (status.source === "managed") {
        const platform = status.platform || await this.detectPlatform();
        const [artifact, state] = await Promise.all([
          this.#resolveArtifact(agentId, { platform, verify: false }),
          this.#readJson((await this.#paths(agentId)).managedState),
        ]);
        const current = status.status === "ready"
          && state?.version === artifact.version
          && state?.sha256 === artifact.sha256
          && (state?.compatibilityId || null) === (artifact.compatibilityId || null)
          && state?.binaryPath === status.binaryPath;
        if (!current) {
          await this.install(agentId, { platform, force: status.status !== "ready" });
          status = await this.status(agentId, { source: "managed" });
        }
      }

      invariant(status.status === "ready", "AGENT_RUNTIME_NOT_READY", `${status.displayName} 运行时不可用`, {
        status: 409,
        details: { agentId },
      });
      return status;
    })().then((value) => {
      this.runtimeCache.set(key, { checkedAt: now, value });
      return value;
    }).finally(() => this.runtimePending.delete(key));
    this.runtimePending.set(key, pending);
    return structuredClone(await pending);
  }
}

export { DEPLOY_SCRIPT };
