import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified } from "./artifact-download.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = path.join(root, "agent-app");
const manifest = JSON.parse(await readFile(path.join(catalogRoot, "manifest.json"), "utf8"));
const args = process.argv.slice(2);
const supported = new Set(["linux-x64", "linux-x64-musl"]);
if (args.includes("--help")) {
  console.log("Usage: node scripts/download-agent-app.mjs [linux-x64] [linux-x64-musl]\nDefault: both x64 variants. Downloads the pinned versions in agent-app/manifest.json.");
} else {
  const platforms = args.length ? args : [...supported];
  if (platforms.some((entry) => !supported.has(entry))) throw new Error("Only linux-x64 and linux-x64-musl agent assets are supported by this release downloader");
  const downloaded = new Set();
  for (const [name, agent] of Object.entries(manifest.agents)) {
    for (const platform of platforms) {
      const artifact = agent.artifacts[platform];
      if (!artifact) throw new Error(`No ${name} artifact for ${platform}`);
      const destination = path.resolve(catalogRoot, artifact.file);
      if (!destination.startsWith(`${catalogRoot}${path.sep}`)) throw new Error("Agent artifact path escapes agent-app");
      if (downloaded.has(destination)) continue;
      await downloadVerified({ url: artifact.source, destination, sha256: artifact.sha256 });
      downloaded.add(destination);
    }
  }
  console.log("Agent packages are ready. / Agent 安装包已就绪。");
}
