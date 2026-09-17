import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, downloadVerified } from "../scripts/artifact-download.mjs";

export const agentIds = ["opencode", "codex", "claudecode", "qodercncli"];
export const platforms = ["linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl"];
const defaultRoot = path.dirname(fileURLToPath(import.meta.url));
const claudeBase = "https://downloads.claude.ai/claude-code-releases";
const claudeFallbackBase = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const qoderCnBase = "https://static.qoder.com.cn/qoder-cli-cn";
const qoderOptimizedCpuFlags = ["sse4_2", "popcnt", "avx", "avx2", "bmi1", "bmi2", "fma"];
const help = [
  "Agent binary updater / Agent 二进制更新器",
  "Usage: node agent-app/update-agent-app.mjs [options]",
  "  --locked          Download/repair versions in manifest.json (default).",
  "                    按清单安装或修复，默认模式。",
  "  --latest          Download latest official releases and update the catalog.",
  "                    下载官方最新版本并更新清单。",
  "  --check           Verify local files without downloading or changing files.",
  "                    只检查本地文件，不联网、不改动。",
  "  --agent NAME      opencode, codex, claudecode, qodercncli; comma-separated, default: all.",
  "  --platform NAME   linux-x64, linux-x64-musl, linux-arm64, linux-arm64-musl.",
  "                    Comma-separated; default: platforms already in the catalog.",
  "                    Manifest-pinned host compatibility releases are retained too.",
  "  --help            Show this help.",
  "",
  "Windows: agent-app\\update-agent-app.cmd [options]",
  "Linux:   sh agent-app/update-agent-app.sh [options]",
  "PowerShell: .\\agent-app\\update-agent-app.ps1 [-Latest | -Locked | -Check] [-Agent codex] [-Platform linux-x64]",
  "",
  "Downloads and verifies the local artifact catalog for Linux x64/arm64 and glibc/musl servers.",
  "只下载并校验本地制品目录，覆盖 Linux x64/arm64、glibc/musl 与清单固定的主机兼容版本。",
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
    const defaults = key === "agents" ? allowed : [];
    options[key] = [...new Set(options[key].length ? options[key] : defaults)];
    if (options[key].some((value) => !allowed.includes(value))) throw new Error("Unsupported " + key + ": " + options[key].join(", "));
  }
  return options;
}

async function metadata(url, { text = false } = {}) {
  const headers = { "User-Agent": "EasyWork-Agent-Artifact-Updater" };
  if (new URL(url).hostname === "api.github.com") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
    const token = String(process.env.GITHUB_TOKEN || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        const error = new Error("HTTP " + response.status + ": " + url);
        error.status = response.status;
        throw error;
      }
      return text ? (await response.text()).trim() : await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

async function githubLatestReleasePage(repository) {
  const headers = { "User-Agent": "EasyWork-Agent-Artifact-Updater" };
  let latest;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      latest = await fetch("https://github.com/" + repository + "/releases/latest", {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!latest.ok) throw new Error("HTTP " + latest.status + ": " + latest.url);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  const latestUrl = new URL(latest.url);
  const prefix = "/" + repository + "/releases/tag/";
  if (latestUrl.origin !== "https://github.com" || !latestUrl.pathname.startsWith(prefix)) throw new Error("Invalid GitHub latest-release redirect");
  const tagName = decodeURIComponent(latestUrl.pathname.slice(prefix.length));
  validVersion(tagName.replace(/^(?:rust-v|v)/, ""));
  const expandedUrl = "https://github.com/" + repository + "/releases/expanded_assets/" + encodeURIComponent(tagName);
  const html = await metadata(expandedUrl, { text: true });
  const assets = [];
  const linkPattern = /href="([^"?#]+\/releases\/download\/[^"?#]+)"/g;
  for (const match of html.matchAll(linkPattern)) {
    const href = match[1];
    if (!href.startsWith("/" + repository + "/releases/download/")) continue;
    const blockEnd = html.indexOf("</li>", match.index);
    const block = html.slice(match.index, blockEnd < 0 ? match.index + 3_000 : blockEnd);
    const digestMatch = block.match(/sha256:([a-f0-9]{64})/);
    if (!digestMatch) continue;
    const source = new URL(href, "https://github.com");
    assets.push({
      name: decodeURIComponent(source.pathname.split("/").at(-1)),
      digest: "sha256:" + digestMatch[1],
      browser_download_url: source.href,
    });
  }
  if (!assets.length) throw new Error("GitHub release page did not expose official SHA-256 digests");
  return { tag_name: tagName, draft: false, prerelease: false, assets };
}

async function githubLatestRelease(repository, request) {
  try {
    return await request("https://api.github.com/repos/" + repository + "/releases/latest");
  } catch (error) {
    if (request !== metadata || ![403, 429].includes(Number(error.status))) throw error;
    return await githubLatestReleasePage(repository);
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
  let artifactBase;
  if (agentId === "qodercncli") {
    source = qoderCnBase + "/channels/manifest.json";
    release = await request(source);
    version = validVersion(String(release.latest || ""));
  } else if (agentId === "claudecode") {
    let base = claudeBase;
    try {
      version = validVersion(await request(base + "/latest", { text: true }));
    } catch (error) {
      if (request !== metadata) throw error;
      base = claudeFallbackBase;
      version = validVersion(await request(base + "/latest", { text: true }));
    }
    artifactBase = base;
    source = base + "/" + version + "/manifest.json";
    release = await request(source);
  } else {
    const repository = agentId === "opencode" ? "anomalyco/opencode" : "openai/codex";
    release = await githubLatestRelease(repository, request);
    if (release.draft || release.prerelease) throw new Error("Expected an official stable release");
    version = validVersion(String(release.tag_name || "").replace(agentId === "opencode" ? /^v/ : /^rust-v/, ""));
    source = "https://github.com/" + repository + "/releases/tag/" + encodeURIComponent(release.tag_name);
  }
  for (const platform of selectedPlatforms) {
    let artifact;
    let filename;
    if (agentId === "qodercncli") {
      const arch = platform === "linux-x64" ? "amd64"
        : platform === "linux-x64-musl" ? "amd64-musl"
          : platform === "linux-arm64" ? "arm64"
            : "arm64-musl";
      const entry = release.files?.find((item) => item.os === "linux" && item.arch === arch);
      filename = `qoderclicn-${platform}.tar.gz`;
      artifact = {
        archive: "tar.gz",
        binary: "qoderclicn",
        sha256: entry?.sha256,
        source: entry?.url,
      };
    } else if (agentId === "claudecode") {
      filename = "claude-" + platform;
      const entry = release.platforms?.[platform];
      artifact = { archive: "raw", sha256: entry?.checksum, source: artifactBase + "/" + version + "/" + platform + "/claude" };
      if (entry?.size !== undefined) artifact.size = entry.size;
    } else {
      const codexArchitecture = platform.includes("arm64") ? "aarch64" : "x86_64";
      filename = agentId === "opencode" ? "opencode-" + platform + ".tar.gz" : "codex-" + codexArchitecture + "-unknown-linux-musl.tar.gz";
      const asset = release.assets?.find((entry) => entry.name === filename);
      artifact = {
        archive: "tar.gz",
        binary: agentId === "opencode" ? "opencode" : "codex-" + codexArchitecture + "-unknown-linux-musl",
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
  if (agentId !== "qodercncli" || !selectedPlatforms.includes("linux-x64")) return { version, source, artifacts };
  const baseline = release.files?.find((item) => item.os === "linux" && item.arch === "amd64-baseline");
  if (!/^[a-f0-9]{64}$/.test(baseline?.sha256 || "") || !String(baseline?.url || "").startsWith("https://")) {
    throw new Error("Missing official SHA-256 for qodercncli/linux-x64-baseline");
  }
  const baselineFilename = "qoderclicn-linux-x64-baseline.tar.gz";
  return {
    version,
    source,
    artifacts,
    compatibility: {
      "linux-x64-baseline": {
        version,
        source,
        selector: { platforms: ["linux-x64"], missingCpuFlags: qoderOptimizedCpuFlags },
        artifacts: {
          "linux-x64": {
            archive: "tar.gz",
            binary: "qoderclicn",
            sha256: baseline.sha256,
            source: baseline.url,
            file: `qodercncli/${version}/${baseline.sha256.slice(0, 16)}-${baselineFilename}`,
          },
        },
      },
    },
  };
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

function compatibilityReleases(agent) {
  if (!agent?.compatibility) return [];
  if (Array.isArray(agent.compatibility)) return agent.compatibility;
  return Object.entries(agent.compatibility).map(([id, release]) => ({ id, ...release }));
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
      // Pinned installs and offline checks remain compatible with catalogs
      // produced before a newly supported Agent was added.  The new Agent is
      // introduced only by an explicit/latest refresh.
      if (!current && options.mode !== "latest") {
        log("[" + options.mode + "] " + agentId + " is not present in this catalog; run --latest to add it");
        continue;
      }
      const selectedPlatforms = options.platforms.length
        ? options.platforms
        : Object.keys(current?.artifacts || {}).filter((platform) => platforms.includes(platform));
      if (!selectedPlatforms.length && options.mode === "latest") selectedPlatforms.push(...platforms);
      if (!selectedPlatforms.length) throw new Error("Missing supported platforms: " + agentId);
      const agent = options.mode === "latest" ? await resolveLatest(agentId, selectedPlatforms, request) : current;
      validVersion(agent?.version);
      if (options.mode === "latest") {
        // Do not advertise older platform binaries under a newer agent version.
        next.agents[agentId] = {
          ...agent,
          ...(agent.compatibility
            ? { compatibility: structuredClone(agent.compatibility) }
            : current?.compatibility ? { compatibility: structuredClone(current.compatibility) } : {}),
          artifacts: { ...(current?.version === agent.version ? current.artifacts : {}), ...agent.artifacts },
        };
      }
      const releases = [
        { label: agentId, release: agent, required: true },
        ...compatibilityReleases(next.agents[agentId]).map((release) => ({
          label: `${agentId}/${release.id || "compatibility"}`,
          release,
          required: false,
        })),
      ];
      for (const { label, release, required } of releases) {
        validVersion(release?.version);
        for (const platform of selectedPlatforms) {
          const artifact = release.artifacts?.[platform];
          if (!artifact) {
            if (required) throw new Error("Missing artifact: " + label + "/" + platform);
            continue;
          }
          if (options.mode !== "latest" && !Number.isSafeInteger(artifact.size)) throw new Error("Missing pinned artifact size");
          const destination = await artifactPath(root, agentId, artifact);
          const existing = jobs.get(destination);
          if (existing && (existing[0].artifact.sha256 !== artifact.sha256 || existing[0].artifact.size !== artifact.size)) throw new Error("Conflicting artifacts share a path");
          jobs.set(destination, [...(existing || []), { artifact }]);
        }
      }
      log("[" + options.mode + "] " + agentId + " " + agent.version + " (" + selectedPlatforms.join(", ") + ")");
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
