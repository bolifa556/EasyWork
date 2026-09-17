import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Run with a package extracted outside the source checkout so missing runtime
// dependencies cannot accidentally resolve from the developer's node_modules.
const root = path.resolve(process.argv[2] || ".");
const metadata = JSON.parse(await readFile(path.join(root, "release.json"), "utf8"));
assert.equal(process.arch, "x64");
assert.equal(process.versions.node, metadata.nodeVersion);
assert.deepEqual(metadata.agentPlatforms, ["linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl"]);
const agentRoot = path.join(root, "agent-app");
const agentManifest = JSON.parse(await readFile(path.join(agentRoot, "manifest.json"), "utf8"));
assert.deepEqual(Object.keys(agentManifest.agents).sort(), ["claudecode", "codex", "opencode", "qodercncli"]);
const { HostAgentArtifactCatalog } = await import(pathToFileURL(path.join(root, "gateway/core/agent-runtime/manifest.mjs")));
const catalog = new HostAgentArtifactCatalog({ root: agentRoot });
const runtimeAgentId = (id) => ({ claudecode: "claude-code", qodercncli: "qoder-cn" })[id] || id;
for (const [id, agent] of Object.entries(agentManifest.agents)) {
  assert.equal(agent.version, metadata.agents[id]);
  assert.deepEqual(Object.keys(agent.artifacts).sort(), [...metadata.agentPlatforms].sort(), "All declared remote Linux agent platforms");
  for (const platform of metadata.agentPlatforms) await catalog.resolve(runtimeAgentId(id), platform, { verify: false });
}
async function runUpdater(command, args) {
  const updater = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [updater.stdout, updater.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const [code] = await once(updater, "exit");
  assert.equal(code, 0, output);
  assert.ok(output.includes("Agent packages verified and ready"), output);
}
if (process.platform === "win32") {
  await runUpdater(process.env.ComSpec || "cmd.exe", ["/d", "/c", "agent-app\\update-agent-app.cmd", "--check"]);
  await runUpdater("powershell.exe", ["-NoProfile", "-File", path.join(agentRoot, "update-agent-app.ps1"), "-Check", "-Agent", "codex"]);
} else {
  await runUpdater("sh", [path.join(agentRoot, "update-agent-app.sh"), "--check"]);
}
const requirePackage = createRequire(path.join(root, "package.json"));
const { createCanvas } = requirePackage("@napi-rs/canvas");
const canvas = createCanvas(32, 32);
canvas.getContext("2d").fillRect(0, 0, 16, 16);
assert.ok(canvas.toBuffer("image/png").length > 50, "Native image rendering");
const { DefaultResourceExtractor } = await import(pathToFileURL(path.join(root, "gateway/core/resources/extractor.mjs")));
const textContent = "EasyWork release document extraction works correctly.";
const stream = `BT /F1 12 Tf 30 100 Td (${textContent}) Tj ET`;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const extracted = await new DefaultResourceExtractor().extract({ filename: "smoke.pdf", mime: "application/pdf", content: Buffer.from(pdf) });
assert.ok(extracted.text.includes(textContent), "PDF extraction and worker assets");
const JSZip = requirePackage("jszip");
const document = new JSZip();
document.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
document.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${textContent}</w:t></w:r></w:p></w:body></w:document>`);
const word = await new DefaultResourceExtractor().extract({ filename: "smoke.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: await document.generateAsync({ type: "nodebuffer" }) });
assert.ok(word.text.includes(textContent), "Word extraction");
assert.equal(typeof requirePackage("ssh2").Client, "function");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "easywork-smoke-"));
const publicPort = await freePort();
let rendererPort = await freePort();
while (rendererPort === publicPort) rendererPort = await freePort();
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EASYWORK_") && !["NODE_PATH", "NODE_OPTIONS"].includes(key)));
const child = spawn(process.execPath, [path.join(root, "scripts/serve-easywork.mjs")], {
  cwd: root,
  env: { ...environment, NODE_ENV: "production", EASYWORK_DATA_ROOT: path.join(temporary, "data"), EASYWORK_BUILD_ROOT: path.join(temporary, "build", "dist"), EASYWORK_WEB_PORT: String(publicPort), EASYWORK_WEB_INTERNAL_PORT: String(rendererPort) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = (logs + chunk).slice(-12_000); });
const exited = once(child, "exit");
const url = `http://127.0.0.1:${publicPort}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Service exited early:\n${logs}`);
    if (await fetch(url).then((response) => response.ok).catch(() => false)) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Startup deadline exceeded:\n${logs}`);
  const page = await fetch(url);
  const html = await page.text();
  assert.ok(html.includes("EasyWork"), "Server-rendered home page");
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))/g)].map((match) => match[1]))];
  assert.ok(assets.length > 0, "Production asset references");
  for (const asset of assets) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
  }
  assert.equal((await fetch(url + "/api/bootstrap")).status, 401, "Authentication required");
  const response = await fetch(url + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "release-check", password: "release-smoke-password", deviceId: "release-check-device" }) });
  assert.ok(response.ok, `Registration status: ${response.status}`);
  const session = (await response.json()).data;
  assert.ok(session.token && session.profile.admin, "First-user administrator setup");
  const bootstrap = await fetch(url + "/api/bootstrap", { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(bootstrap.status, 200, "Authenticated startup");
  const initial = (await bootstrap.json()).data;
  assert.equal(initial.recentConversations.length, 0, "Clean conversation store");
  assert.equal(initial.servers.length, 0, "No packaged server credentials");
  const { WebSocket } = await import(pathToFileURL(path.join(root, "node_modules/ws/wrapper.mjs")));
  const socket = new WebSocket(url.replace("http:", "ws:") + "/easywork-ws");
  const timeout = setTimeout(() => socket.terminate(), 10_000);
  try {
    await once(socket, "open");
    const authenticated = once(socket, "message");
    socket.send(JSON.stringify({ type: "authenticate", token: session.token }));
    assert.equal(JSON.parse((await authenticated)[0]).type, "authenticated", "Realtime authentication");
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
  console.log(JSON.stringify({ target: metadata.target, os: `${os.type()} ${os.release()}`, node: process.versions.node, arch: process.arch, agents: metadata.agents, checks: ["bundled remote Linux agent catalog", "native updater scripts and SHA-256 verification", "native canvas", "PDF extraction", "Word extraction", "SSH library", "home page", `${assets.length} static assets`, "registration", "clean data", "authenticated API", "WebSocket"] }, null, 2));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (child.exitCode === null) {
    if (process.platform === "win32") {
      const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      await once(kill, "exit");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  }
  await exited;
  // Only remove the directory created by this smoke run.
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), "easywork-smoke-")));
  await rm(temporary, { recursive: true, force: true });
}
