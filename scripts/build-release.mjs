import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace } from "@vercel/nft";
import { digest, downloadVerified } from "./artifact-download.mjs";
import { agentIds, artifactPath, platforms as agentPlatforms } from "../agent-app/update-agent-app.mjs";

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
  console.log("Build x64 releases with pinned Node.js runtimes and all Linux x64 agent installers. Requires Node.js, Python 3.9+ and tar.\nRun npm run agents:download first.\nOptions: --skip-build.\nTargets: " + Object.keys(config.targets).join(", "));
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid release version");

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
const entries = ["ws", "ssh2", "mammoth", "pdf-parse", "yaml", "unified", "remark-parse", "remark-gfm", "vinext/server/prod-server"]
  .map((entry) => fileURLToPath(import.meta.resolve(entry)));
const trace = await nodeFileTrace(entries, {
  base: root,
  processCwd: path.join(cache, "empty"),
  ignore: (entry) => !entry.replaceAll("\\", "/").startsWith("node_modules/"),
});
const optionalWarnings = /sshcrypto\.node|cpufeatures\.node|"bufferutil"|"utf-8-validate"|pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs as script/;
const unexpected = [...trace.warnings].filter((warning) => !optionalWarnings.test(warning.message));
if (unexpected.length) throw new Error(unexpected.map((warning) => warning.message).join("\n"));
const dependencies = [...trace.fileList].map((entry) => entry.replaceAll("\\", "/"))
  .filter((entry) => entry.startsWith("node_modules/") && !/node_modules\/@napi-rs\/canvas-[^/]+\//.test(entry) && !entry.endsWith(".node"));

const common = path.join(cache, "common");
await resetStage(common);
for (const entry of ["dist", "gateway", "shared", "prompts", "help", "public", "doc", "assets", "README.md", "README_zh.md", ".env.example", "agent-app/update-agent-app.mjs"]) {
  await copyRelative(entry, common);
}
// The host may be Windows or Linux; managed agents run on remote Linux servers.
// Include only the verified x64 catalog, never the whole local agent-app folder.
const agentRoot = await realpath(path.join(root, "agent-app"));
const sourceCatalog = JSON.parse(await readFile(path.join(agentRoot, "manifest.json"), "utf8"));
if (sourceCatalog.schemaVersion !== 1) throw new Error("Unsupported agent catalog schema");
const agentCatalog = { schemaVersion: 1, updatedAt: sourceCatalog.updatedAt, agents: {} };
const includedAgents = new Set();
for (const agentId of agentIds) {
  const agent = sourceCatalog.agents?.[agentId];
  if (!agent?.version) throw new Error("Missing agent: " + agentId);
  agentCatalog.agents[agentId] = { ...agent, artifacts: {} };
  for (const platform of agentPlatforms) {
    const artifact = agent.artifacts?.[platform];
    if (!artifact) throw new Error("Missing agent platform: " + agentId + "/" + platform);
    const file = await artifactPath(agentRoot, agentId, artifact);
    if (!includedAgents.has(file)) {
      const info = await stat(file).catch(() => { throw new Error("Missing agent installer. Run npm run agents:download first: " + file); });
      if (!info.isFile() || info.size !== artifact.size || await digest(file) !== artifact.sha256) throw new Error("Agent integrity check failed. Run npm run agents:download: " + file);
      await copyRelative("agent-app/" + artifact.file, common);
      includedAgents.add(file);
    }
    agentCatalog.agents[agentId].artifacts[platform] = artifact;
  }
}
await writeFile(path.join(common, "agent-app", "manifest.json"), JSON.stringify(agentCatalog, null, 2) + "\n");
console.log("[release] Bundling " + includedAgents.size + " verified Linux x64 agent files in every host archive");
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

  const native = lock.packages[`node_modules/${target.canvasPackage}`];
  if (!native?.integrity || !native?.resolved) throw new Error(`Missing locked canvas package: ${target.canvasPackage}`);
  const nativeArchive = await downloadVerified({ url: native.resolved, integrity: native.integrity, destination: path.join(downloads, `${target.canvasPackage.split("/").pop()}-${native.version}.tgz`) });
  const nativeUnpack = path.join(cache, `native-${targetName}`);
  await resetStage(nativeUnpack);
  await run("tar", ["-xf", nativeArchive, "-C", nativeUnpack]);
  await cp(path.join(nativeUnpack, "package"), path.join(stage, "node_modules", target.canvasPackage), { recursive: true });
  // The native canvas package uses the same MIT license as @napi-rs/canvas.
  await writeFile(path.join(stage, "THIRD_PARTY_NOTICES.md"), notices.join("\n") + `\n| ${target.canvasPackage} | ${native.version} | MIT |\n| Node.js | ${config.nodeVersion} | See runtime/LICENSE |\n`);
  const launcher = target.platform === "win32" ? "start.cmd" : "start.sh";
  const launcherText = await readFile(path.join(root, "scripts", "release", launcher), "utf8");
  await writeFile(path.join(stage, launcher), launcherText.replace(/\r?\n/g, target.platform === "win32" ? "\r\n" : "\n"));
  for (const entry of target.platform === "win32" ? ["update-agent-app.cmd", "update-agent-app.ps1"] : ["update-agent-app.sh"]) {
    const text = await readFile(path.join(agentRoot, entry), "utf8");
    await writeFile(path.join(stage, "agent-app", entry), text.replace(/\r?\n/g, target.platform === "win32" ? "\r\n" : "\n"));
  }
  await writeFile(path.join(stage, "release.json"), JSON.stringify({ name: pkg.name, version: pkg.version, target: targetName, arch: "x64", systems: target.systems, nodeVersion: config.nodeVersion, runtimeUrl: target.url, runtimeSha256: target.sha256, runtimeNote: target.runtimeNote, lockfileSha256: await digest(path.join(root, "package-lock.json")), agentPlatforms, agents: Object.fromEntries(Object.entries(agentCatalog.agents).map(([id, agent]) => [id, agent.version])) }, null, 2) + "\n");
  await run(python, ["scripts/release/archive.py", stage, path.join(output, `${name}${target.platform === "win32" ? ".zip" : ".tar.gz"}`)]);
}

// Older local builds used a separate optional agent archive. All host archives
// now include those files; remove only that exact obsolete output file.
await rm(path.join(output, "easywork-" + pkg.version + "-agent-assets-linux-x64.tar.gz"), { force: true });

const artifacts = (await readdir(output)).filter((entry) => entry.startsWith(`easywork-${pkg.version}-`) && /\.(zip|tar\.gz)$/.test(entry)).sort();
const checksums = [];
for (const artifact of artifacts) checksums.push(`${await digest(path.join(output, artifact))}  ${artifact}`);
await writeFile(path.join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
console.log(`[release] ${artifacts.length} archives ready in ${output}`);
