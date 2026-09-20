import { lstat, open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, downloadVerified } from "../scripts/artifact-download.mjs";

export const agentIds = ["opencode", "codex", "claudecode", "qodercncli"];
export const platforms = ["linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl"];
const defaultRoot = path.dirname(fileURLToPath(import.meta.url));
const help = [
  "EasyWork Agent installer / Agent 安装文件下载工具",
  "Usage: node agent-app/update-agent-app.mjs --agent NAME [options]",
  "  --agent NAME      opencode, codex, claudecode, qodercncli; comma-separated.",
  "                    只下载指定的 Agent，可用逗号选择多个。",
  "  --all             Explicitly select all four Agents / 明确选择全部四个 Agent。",
  "  --platform NAME   Remote Linux platform; default: linux-x64.",
  "                    linux-x64, linux-x64-musl, linux-arm64, linux-arm64-musl.",
  "                    远端服务器的平台，与运行脚本的 Windows/Linux 主机无关；可用逗号选择多个。",
  "  --locked          Download/repair the versions pinned in manifest.json (default).",
  "                    固定下载本版 EasyWork 配套版本，不查询或升级至上游最新版。",
  "  --check           Verify selected local files offline / 离线校验所选安装文件。",
  "  --help            Show help. No arguments also show help without downloading.",
  "                    不带参数只显示帮助，不下载。",
  "",
  "Windows:    agent-app\\update-agent-app.cmd --agent codex",
  "Linux:      sh agent-app/update-agent-app.sh --agent opencode",
  "PowerShell: .\\agent-app\\update-agent-app.ps1 -Agent qodercncli -Platform linux-x64",
  "",
  "SHA-256 and file sizes are verified; matching pinned compatibility builds are included.",
  "下载后校验 SHA-256 和文件大小，同时准备清单中适用于所选平台的兼容版本。",
  "Then connect SSH in EasyWork and install the selected Agent on the remote server.",
  "下载完成后，在 EasyWork 中连接 SSH 并安装对应 Agent。",
].join("\n");

export function parseOptions(args) {
  const options = { mode: "locked", agents: [], platforms: [], help: args.length === 0 || args.includes("--help") };
  let explicitMode;
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].split("=", 2);
    if (flag === "--help" && inline === undefined) continue;
    if (["--locked", "--check"].includes(flag) && inline === undefined) {
      if (explicitMode && explicitMode !== flag) throw new Error("Choose only one of --locked and --check");
      explicitMode = flag;
      options.mode = flag.slice(2);
    } else if (flag === "--all" && inline === undefined) {
      all = true;
    } else if (["--agent", "--platform"].includes(flag)) {
      const value = inline ?? args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
      options[flag === "--agent" ? "agents" : "platforms"].push(...value.split(",").map((item) => item.trim()));
    } else if (platforms.includes(flag)) {
      options.platforms.push(flag);
    } else if (flag === "--latest") {
      throw new Error("Versions are pinned to this EasyWork release. Use --agent NAME; --latest is not supported. / 请用 --agent 选择固定版本。");
    } else {
      throw new Error("Unknown argument: " + args[index]);
    }
  }
  if (all && options.agents.length) throw new Error("Choose either --agent or --all");
  if (all) options.agents = [...agentIds];
  if (!options.agents.length && !options.help) throw new Error("Select an Agent with --agent NAME, or use --all. / 请通过 --agent 指定要安装的 Agent。");
  if (!options.platforms.length) options.platforms = ["linux-x64"];
  for (const [key, allowed] of [["agents", agentIds], ["platforms", platforms]]) {
    options[key] = [...new Set(options[key])];
    if (options[key].some((value) => !allowed.includes(value))) throw new Error("Unsupported " + key + ": " + options[key].join(", "));
  }
  return options;
}

function validVersion(value) {
  if (typeof value !== "string" || !/^[0-9][0-9A-Za-z._-]*$/.test(value)) throw new Error("Invalid agent version");
  return value;
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
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error("Missing or invalid pinned artifact size");
  return destination;
}

export function compatibilityReleases(agent) {
  if (!agent?.compatibility) return [];
  if (Array.isArray(agent.compatibility)) return agent.compatibility;
  return Object.entries(agent.compatibility).map(([id, release]) => ({ id, ...release }));
}

export async function updateCatalog(args, { catalogRoot = defaultRoot, download = downloadVerified, log = console.log } = {}) {
  const options = parseOptions(args);
  if (options.help) { log(help); return; }
  const root = await realpath(catalogRoot);
  const lockFile = path.join(root, ".update.lock");
  let lock;
  try {
    if (options.mode !== "check") {
      lock = await open(lockFile, "wx").catch((error) => {
        if (error.code === "EEXIST") throw new Error("Agent update is locked. If no updater is running, remove agent-app/.update.lock and retry.");
        throw error;
      });
      await lock.writeFile(String(process.pid) + "\n");
    }
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || !manifest.agents || Array.isArray(manifest.agents) || typeof manifest.agents !== "object") throw new Error("Invalid agent manifest; restore manifest.json before retrying");
    const jobs = new Map();
    for (const agentId of options.agents) {
      const agent = manifest.agents[agentId];
      if (!agent) throw new Error("Agent is not present in this pinned catalog: " + agentId);
      const releases = [
        { label: agentId, release: agent, required: true },
        ...compatibilityReleases(agent).map((release) => ({ label: `${agentId}/${release.id || "compatibility"}`, release, required: false })),
      ];
      for (const { label, release, required } of releases) {
        validVersion(release?.version);
        for (const platform of options.platforms) {
          const artifact = release.artifacts?.[platform];
          if (!artifact) {
            if (required) throw new Error("Missing artifact: " + label + "/" + platform);
            continue;
          }
          const destination = await artifactPath(root, agentId, artifact);
          const existing = jobs.get(destination);
          if (existing && (existing.sha256 !== artifact.sha256 || existing.size !== artifact.size)) throw new Error("Conflicting artifacts share a path");
          jobs.set(destination, artifact);
        }
      }
      log("[" + options.mode + "] " + agentId + " " + agent.version + " (" + options.platforms.join(", ") + ")");
    }
    for (const [destination, artifact] of jobs) {
      if (options.mode !== "check") await download({ url: artifact.source, sha256: artifact.sha256, size: artifact.size, destination });
      const info = await stat(destination).catch((error) => {
        if (error.code === "ENOENT") throw new Error("Missing Agent file; run the same command without --check: " + destination);
        throw error;
      });
      if (!info.isFile() || info.size !== artifact.size || await digest(destination) !== artifact.sha256) throw new Error("Agent integrity check failed: " + destination);
    }
    log("Agent packages verified and ready. / Agent 安装文件已校验并就绪。");
    return { manifest, files: jobs.size };
  } finally {
    if (lock) {
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
