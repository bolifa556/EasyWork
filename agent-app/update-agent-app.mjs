import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, downloadVerified } from "../scripts/artifact-download.mjs";

export const agentIds = ["opencode", "codex", "claudecode"];
export const platforms = ["linux-x64", "linux-x64-musl"];
const defaultRoot = path.dirname(fileURLToPath(import.meta.url));
const claudeBase = "https://downloads.claude.ai/claude-code-releases";
const help = [
  "EasyWork Agent installer / Agent 安装与更新",
  "Usage: node agent-app/update-agent-app.mjs [options]",
  "  --locked          Download/repair versions in manifest.json (default).",
  "                    按清单安装或修复，默认模式。",
  "  --latest          Download latest official releases and update the catalog.",
  "                    下载官方最新版本并更新清单。",
  "  --check           Verify local files without downloading or changing files.",
  "                    只检查本地文件，不联网、不改动。",
  "  --agent NAME      opencode, codex, claudecode; comma-separated, default: all.",
  "  --platform NAME   linux-x64, linux-x64-musl; comma-separated, default: both.",
  "  --help            Show this help.",
  "",
  "Windows: agent-app\\update-agent-app.cmd [options]",
  "Linux:   sh agent-app/update-agent-app.sh [options]",
  "PowerShell: .\\agent-app\\update-agent-app.ps1 [-Latest | -Check] [-Agent codex]",
  "",
  "Run on the EasyWork host. These are installers for remote Linux x64 servers.",
  "在 EasyWork 主机运行，下载的是远端 Linux x64 服务器使用的 Agent。",
  "After downloading, connect SSH and install/update the agent in EasyWork.",
  "下载后请在 EasyWork 连接 SSH，并安装或更新远端 Agent。",
].join("\n");

export function parseOptions(args) {
  const options = { mode: "locked", agents: [], platforms: [], help: args.includes("--help") };
  let explicitMode;
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].split("=", 2);
    if (flag === "--help") continue;
    if (["--locked", "--latest", "--check"].includes(flag) && inline === undefined) {
      if (explicitMode && explicitMode !== flag) throw new Error("Choose only one of --locked, --latest and --check");
      explicitMode = flag;
      options.mode = flag.slice(2);
    } else if (["--agent", "--platform"].includes(flag)) {
      const value = inline ?? args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
      options[flag === "--agent" ? "agents" : "platforms"].push(...value.split(","));
    } else if (platforms.includes(flag)) {
      options.platforms.push(flag);
    } else {
      throw new Error("Unknown argument: " + args[index]);
    }
  }
  for (const [key, allowed] of [["agents", agentIds], ["platforms", platforms]]) {
    options[key] = [...new Set(options[key].length ? options[key] : allowed)];
    if (options[key].some((value) => !allowed.includes(value))) throw new Error("Unsupported " + key + ": " + options[key].join(", "));
  }
  return options;
}

async function metadata(url, { text = false } = {}) {
  const headers = { "User-Agent": "EasyWork-Agent-Artifact-Updater" };
  if (new URL(url).hostname === "api.github.com") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("HTTP " + response.status + ": " + url);
      return text ? (await response.text()).trim() : await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

function validVersion(value) {
  if (typeof value !== "string" || !/^[0-9][0-9A-Za-z._-]*$/.test(value)) throw new Error("Invalid agent version");
  return value;
}

export async function resolveLatest(agentId, selectedPlatforms, request = metadata) {
  const artifacts = {};
  let version;
  let source;
  let release;
  if (agentId === "claudecode") {
    version = validVersion(await request(claudeBase + "/latest", { text: true }));
    source = claudeBase + "/" + version + "/manifest.json";
    release = await request(source);
  } else {
    const repository = agentId === "opencode" ? "anomalyco/opencode" : "openai/codex";
    release = await request("https://api.github.com/repos/" + repository + "/releases/latest");
    if (release.draft || release.prerelease) throw new Error("Expected an official stable release");
    version = validVersion(String(release.tag_name || "").replace(agentId === "opencode" ? /^v/ : /^rust-v/, ""));
    source = "https://github.com/" + repository + "/releases/tag/" + encodeURIComponent(release.tag_name);
  }
  for (const platform of selectedPlatforms) {
    let artifact;
    let filename;
    if (agentId === "claudecode") {
      filename = "claude-" + platform;
      const entry = release.platforms?.[platform];
      artifact = { archive: "raw", sha256: entry?.checksum, source: claudeBase + "/" + version + "/" + platform + "/claude" };
      if (entry?.size !== undefined) artifact.size = entry.size;
    } else {
      filename = agentId === "opencode" ? "opencode-" + platform + ".tar.gz" : "codex-x86_64-unknown-linux-musl.tar.gz";
      const asset = release.assets?.find((entry) => entry.name === filename);
      artifact = {
        archive: "tar.gz",
        binary: agentId === "opencode" ? "opencode" : "codex-x86_64-unknown-linux-musl",
        sha256: asset?.digest?.replace(/^sha256:/, ""),
        source: asset?.browser_download_url,
        size: asset?.size,
      };
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) throw new Error("Missing official SHA-256 for " + agentId + "/" + platform);
    // Separate new artifacts from files referenced by the currently active catalog.
    artifact.file = agentId + "/" + version + "/" + artifact.sha256.slice(0, 16) + "-" + filename;
    artifacts[platform] = artifact;
  }
  return { version, source, artifacts };
}

export async function artifactPath(root, agentId, artifact) {
  const parts = String(artifact?.file || "").split("/");
  if (parts[0] !== agentId || parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw new Error("Unsafe agent artifact path");
  let destination = root;
  for (const part of parts) {
    destination = path.join(destination, part);
    const entry = await lstat(destination).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (entry?.isSymbolicLink()) throw new Error("Agent artifact path contains a symlink: " + destination);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || "") || !["raw", "tar.gz"].includes(artifact.archive)) throw new Error("Invalid agent checksum or archive type");
  if (!String(artifact.source || "").startsWith("https://")) throw new Error("Agent source must use HTTPS");
  if (artifact.archive === "tar.gz" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.binary || "")) throw new Error("Invalid archive binary name");
  if (artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size <= 0)) throw new Error("Invalid agent artifact size");
  return destination;
}

export async function updateCatalog(args, { catalogRoot = defaultRoot, request = metadata, download = downloadVerified, log = console.log } = {}) {
  const options = parseOptions(args);
  if (options.help) { log(help); return; }
  const root = await realpath(catalogRoot);
  const manifestFile = path.join(root, "manifest.json");
  const lockFile = path.join(root, ".update.lock");
  const temporary = path.join(root, ".manifest-" + randomUUID() + ".tmp");
  let lock;
  try {
    if (options.mode !== "check") {
      lock = await open(lockFile, "wx").catch((error) => {
        if (error.code === "EEXIST") throw new Error("Agent update is locked. If no updater is running, remove agent-app/.update.lock and retry.");
        throw error;
      });
      await lock.writeFile(String(process.pid) + "\n");
    }
    const original = await readFile(manifestFile, "utf8");
    const manifest = JSON.parse(original);
    if (manifest.schemaVersion !== 1 || !manifest.agents || Array.isArray(manifest.agents) || typeof manifest.agents !== "object") throw new Error("Invalid agent manifest; restore manifest.json before retrying");
    const next = structuredClone(manifest);
    const jobs = new Map();
    for (const agentId of options.agents) {
      const current = manifest.agents[agentId];
      const agent = options.mode === "latest" ? await resolveLatest(agentId, options.platforms, request) : current;
      validVersion(agent?.version);
      if (options.mode === "latest") {
        // Do not advertise older platform binaries under a newer agent version.
        next.agents[agentId] = { ...agent, artifacts: { ...(current?.version === agent.version ? current.artifacts : {}), ...agent.artifacts } };
      }
      for (const platform of options.platforms) {
        const artifact = agent.artifacts?.[platform];
        if (!artifact) throw new Error("Missing artifact: " + agentId + "/" + platform);
        if (options.mode !== "latest" && !Number.isSafeInteger(artifact.size)) throw new Error("Missing pinned artifact size");
        const destination = await artifactPath(root, agentId, artifact);
        const existing = jobs.get(destination);
        if (existing && (existing[0].artifact.sha256 !== artifact.sha256 || existing[0].artifact.size !== artifact.size)) throw new Error("Conflicting artifacts share a path");
        jobs.set(destination, [...(existing || []), { artifact }]);
      }
      log("[" + options.mode + "] " + agentId + " " + agent.version + " (" + options.platforms.join(", ") + ")");
    }
    for (const [destination, references] of jobs) {
      const artifact = references[0].artifact;
      if (options.mode !== "check") await download({ url: artifact.source, sha256: artifact.sha256, size: artifact.size, destination });
      const size = (await stat(destination)).size;
      if (size <= 0 || (artifact.size !== undefined && size !== artifact.size) || await digest(destination) !== artifact.sha256) throw new Error("Agent integrity check failed: " + destination);
      for (const reference of references) reference.artifact.size = size;
    }
    if (options.mode === "latest") {
      next.updatedAt = new Date().toISOString();
      // Preserve both the previous manifest and its binaries for recovery.
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
      await writeFile(path.join(root, "manifest.json.previous"), original);
      await rename(temporary, manifestFile);
    }
    log("Agent packages verified and ready. / Agent 安装文件已校验并就绪。");
    return { manifest: next, files: jobs.size };
  } finally {
    if (lock) {
      await rm(temporary, { force: true });
      await lock.close();
      await rm(lockFile, { force: true });
    }
  }
}

export async function main(args) {
  try {
    await updateCatalog(args);
  } catch (error) {
    console.error("Agent update failed / Agent 更新失败: " + error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
