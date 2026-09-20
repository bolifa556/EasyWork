import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace } from "@vercel/nft";
import { digest, downloadVerified } from "./artifact-download.mjs";
import { agentIds, artifactPath, compatibilityReleases, platforms as agentPlatforms } from "../agent-app/update-agent-app.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const config = JSON.parse(await readFile(path.join(root, "scripts", "release-targets.json"), "utf8"));
const cache = path.join(root, ".cache", "releases", pkg.version);
const downloads = path.join(root, ".cache", "release-downloads");
const output = path.join(root, "releases");
const args = process.argv.slice(2);
const knownFlags = new Set(["--skip-build", "--help"]);
const targets = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && !knownFlags.has(arg)) || targets.some((target) => !config.targets[target])) {
  throw new Error(`Usage: npm run release -- [--skip-build] [${Object.keys(config.targets).join(" | ")}]`);
}
if (args.includes("--help")) {
  console.log("Build x64 releases with pinned Node.js runtimes and platform-specific Agent download scripts. Agent applications are downloaded separately by users. Requires Node.js, Python 3.9+ and tar.\nOptions: --skip-build.\nTargets: " + Object.keys(config.targets).join(", "));
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid release version");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim()) {
  throw new Error("Commit source changes before building release packages.");
}

function run(command, arguments_, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

const python = process.env.EASYWORK_RELEASE_PYTHON || (process.platform === "win32" ? "python" : "python3");
await run(python, ["-c", "import sys; assert sys.version_info >= (3, 9), 'Python 3.9+ required'"]);
await mkdir(cache, { recursive: true });
await mkdir(downloads, { recursive: true });
await mkdir(output, { recursive: true });

async function resetStage(directory) {
  const resolved = path.resolve(directory);
  const realCache = await realpath(cache);
  if (!resolved.startsWith(`${cache}${path.sep}`) || resolved === cache) throw new Error("Refusing to clear outside release staging");
  const existing = await realpath(resolved).catch(() => null);
  if (existing && !existing.startsWith(`${realCache}${path.sep}`)) throw new Error("Release stage resolves outside cache");
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
}

async function copyRelative(relative, destination) {
  const normalized = relative.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) throw new Error(`Unsafe package path: ${relative}`);
  const to = path.join(destination, normalized);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(path.join(root, normalized), to, { recursive: true, dereference: true });
}

if (!args.includes("--skip-build")) await run(process.execPath, ["scripts/patch-pdfjs-worker.mjs"]);
if (!args.includes("--skip-build")) await run(process.execPath, ["scripts/run-vinext.mjs", "build"]);
await stat(path.join(root, "dist", "server", "index.js"));

// Trace only external runtime entries. Never ask a tracer to walk application
// storage paths; the application itself is copied using the allowlist below.
const entries = ["ws", "ssh2", "mammoth", "pdf-parse", "sharp", "yaml", "unified", "remark-parse", "remark-gfm", "vinext/server/prod-server"]
  .map((entry) => fileURLToPath(import.meta.resolve(entry)));
const trace = await nodeFileTrace(entries, {
  base: root,
  processCwd: path.join(cache, "empty"),
  ignore: (entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return !normalized.startsWith("node_modules/") || /^node_modules\/@img\/sharp-/.test(normalized);
  },
});
const optionalWarnings = /sshcrypto\.node|cpufeatures\.node|"bufferutil"|"utf-8-validate"|pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs as script/;
// Sharp probes optional platform packages that are installed separately below.
const sharpOptionalWarnings = /"@img\/sharp-(?:wasm32\/versions|libvips-[^"\r\n]+\/(?:package|include|cplusplus))"/;
const unexpected = [...trace.warnings].filter((warning) => !optionalWarnings.test(warning.message) && !sharpOptionalWarnings.test(warning.message));
if (unexpected.length) throw new Error(unexpected.map((warning) => warning.message).join("\n"));
const dependencies = [...trace.fileList].map((entry) => entry.replaceAll("\\", "/"))
  .filter((entry) => entry.startsWith("node_modules/") && !/node_modules\/(?:@napi-rs\/canvas-|@img\/sharp-)[^/]+\//.test(entry) && !entry.endsWith(".node"));

const common = path.join(cache, "common");
await resetStage(common);
for (const entry of ["dist", "gateway", "shared", "prompts", "help", "public", "doc", "assets", "LICENSE", "README.md", "README_zh.md", ".env.example", "agent-app/update-agent-app.mjs"]) {
  await copyRelative(entry, common);
}
// Ship only the pinned catalog and download tools. The local Agent binaries,
// even if already downloaded by the developer, never enter a host release.
const agentRoot = await realpath(path.join(root, "agent-app"));
const sourceCatalog = JSON.parse(await readFile(path.join(agentRoot, "manifest.json"), "utf8"));
if (sourceCatalog.schemaVersion !== 1) throw new Error("Unsupported agent catalog schema");
const agentCatalog = { schemaVersion: 1, updatedAt: sourceCatalog.updatedAt, agents: {} };
for (const agentId of agentIds) {
  const agent = sourceCatalog.agents?.[agentId];
  if (!agent?.version) throw new Error("Missing agent: " + agentId);
  agentCatalog.agents[agentId] = structuredClone(agent);
  for (const platform of agentPlatforms) {
    const artifact = agent.artifacts?.[platform];
    if (!artifact) throw new Error("Missing agent platform: " + agentId + "/" + platform);
    await artifactPath(agentRoot, agentId, artifact);
  }
  for (const compatibility of compatibilityReleases(agent)) {
    for (const artifact of Object.values(compatibility.artifacts || {})) await artifactPath(agentRoot, agentId, artifact);
  }
}
await writeFile(path.join(common, "agent-app", "manifest.json"), JSON.stringify(agentCatalog, null, 2) + "\n");
console.log("[release] Including pinned Agent download catalog; no Agent applications bundled");
for (const entry of ["serve-easywork.mjs", "start-renderer.mjs", "static-assets.mjs", "download-agent-app.mjs", "artifact-download.mjs"]) {
  await copyRelative(`scripts/${entry}`, common);
}
for (const entry of dependencies) await copyRelative(entry, common);
// PDF.js discovers fonts, CMaps, workers and WASM via paths computed at runtime.
await copyRelative("node_modules/pdfjs-dist", common);
await copyRelative("node_modules/@napi-rs/canvas", common);
await writeFile(path.join(common, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", engines: { node: ">=22.13.0" } }, null, 2) + "\n");

const packageRoots = new Set(dependencies.map((entry) => {
  const parts = entry.split("/");
  const offset = parts.lastIndexOf("node_modules") + 1;
  return parts.slice(0, offset + (parts[offset].startsWith("@") ? 2 : 1)).join("/");
}));
packageRoots.add("node_modules/pdfjs-dist");
packageRoots.add("node_modules/@napi-rs/canvas");
const notices = ["# Third-party software / 第三方软件", "", "This package includes third-party software. License texts are retained alongside each package and in runtime/LICENSE.", "本包包含第三方软件，许可证保留在相应依赖目录和 runtime/LICENSE 中。", "", "| Package | Version | License |", "| --- | --- | --- |"];
for (const directory of [...packageRoots].sort()) {
  const metadata = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));
  notices.push(`| ${metadata.name} | ${metadata.version} | ${typeof metadata.license === "string" ? metadata.license : metadata.license?.type || "See package license"} |`);
  for (const entry of await readdir(path.join(root, directory))) {
    if (/^(license|licence|copying|notice|copyright)/i.test(entry)) await copyRelative(`${directory}/${entry}`, common);
  }
}
await writeFile(path.join(common, "THIRD_PARTY_NOTICES.md"), notices.join("\n") + "\n");

async function installLockedPackage(packageName, stage, targetName) {
  const metadata = lock.packages[`node_modules/${packageName}`];
  if (!metadata?.integrity || !metadata?.resolved) throw new Error(`Missing locked runtime package: ${packageName}`);
  const filename = `${packageName.replaceAll("/", "-")}-${metadata.version}.tgz`;
  const archive = await downloadVerified({ url: metadata.resolved, integrity: metadata.integrity, destination: path.join(downloads, filename) });
  const unpack = path.join(cache, `package-${targetName}`);
  await resetStage(unpack);
  await run("tar", ["-xf", archive, "-C", unpack]);
  await cp(path.join(unpack, "package"), path.join(stage, "node_modules", packageName), { recursive: true });
  return `| ${packageName} | ${metadata.version} | ${metadata.license || "See package license"} |`;
}

for (const targetName of targets.length ? targets : Object.keys(config.targets)) {
  const target = config.targets[targetName];
  const name = `easywork-${pkg.version}-${targetName}`;
  const stage = path.join(cache, name);
  await resetStage(stage);
  await cp(common, stage, { recursive: true });
  const runtimeArchive = await downloadVerified({ ...target, destination: path.join(downloads, target.archive) });
  const unpack = path.join(cache, `unpack-${targetName}`);
  await resetStage(unpack);
  const runtimeDirectory = target.archive.replace(/\.(?:tar\.(?:gz|xz)|zip)$/, "");
  console.log(`[release] Extracting ${targetName} runtime`);
  await run(python, ["scripts/release/extract-runtime.py", runtimeArchive, unpack, runtimeDirectory, target.platform]);
  const unpackedRuntime = path.join(unpack, runtimeDirectory);
  const runtimeBinary = target.platform === "win32" ? "node.exe" : "bin/node";
  const destination = path.join(stage, "runtime", runtimeBinary);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(unpackedRuntime, runtimeBinary), destination);
  await cp(path.join(unpackedRuntime, "LICENSE"), path.join(stage, "runtime", "LICENSE"));

  const targetNotices = [...notices];
  // CentOS 7 uses Sharp's official WASM fallback because modern native libvips
  // requires a newer glibc. All variants and their dependencies come from the lockfile.
  for (const packageName of [target.canvasPackage, ...target.sharpPackages]) {
    targetNotices.push(await installLockedPackage(packageName, stage, targetName));
  }
  targetNotices.push(`| Node.js | ${config.nodeVersion} | See runtime/LICENSE |`);
  await writeFile(path.join(stage, "THIRD_PARTY_NOTICES.md"), targetNotices.join("\n") + "\n");
  const launcher = target.platform === "win32" ? "start.cmd" : "start.sh";
  const launcherText = await readFile(path.join(root, "scripts", "release", launcher), "utf8");
  await writeFile(path.join(stage, launcher), launcherText.replace(/\r?\n/g, target.platform === "win32" ? "\r\n" : "\n"));
  for (const entry of target.platform === "win32" ? ["update-agent-app.cmd", "update-agent-app.ps1"] : ["update-agent-app.sh"]) {
    const text = await readFile(path.join(agentRoot, entry), "utf8");
    await writeFile(path.join(stage, "agent-app", entry), text.replace(/\r?\n/g, target.platform === "win32" ? "\r\n" : "\n"));
  }
  await writeFile(path.join(stage, "release.json"), JSON.stringify({ name: pkg.name, version: pkg.version, sourceCommit, target: targetName, arch: "x64", systems: target.systems, nodeVersion: config.nodeVersion, runtimeUrl: target.url, runtimeSha256: target.sha256, runtimeNote: target.runtimeNote, lockfileSha256: await digest(path.join(root, "package-lock.json")), agentApplicationsBundled: false, agentPlatforms, agents: Object.fromEntries(Object.entries(agentCatalog.agents).map(([id, agent]) => [id, agent.version])) }, null, 2) + "\n");
  await run(python, ["scripts/release/archive.py", stage, path.join(output, `${name}${target.platform === "win32" ? ".zip" : ".tar.gz"}`)]);
}

// No separate Agent binary archive is produced for this release.
await rm(path.join(output, "easywork-" + pkg.version + "-agent-assets-linux-x64.tar.gz"), { force: true });

const artifacts = (await readdir(output)).filter((entry) => entry.startsWith(`easywork-${pkg.version}-`) && /\.(zip|tar\.gz)$/.test(entry)).sort();
const checksums = [];
for (const artifact of artifacts) checksums.push(`${await digest(path.join(output, artifact))}  ${artifact}`);
await writeFile(path.join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
console.log(`[release] ${artifacts.length} archives ready in ${output}`);
