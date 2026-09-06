import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayServer } from "../gateway/core/server.mjs";
import { archiveClientAssets, builtAssetHandler } from "./static-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const rendererEntry = path.join(root, "scripts", "start-renderer.mjs");
const publicPort = Number(process.env.EASYWORK_WEB_PORT || 8001);
const internalPort = Number(process.env.EASYWORK_WEB_INTERNAL_PORT || 8002);
const buildRoot = path.resolve(
  process.env.EASYWORK_BUILD_ROOT || path.join(root, ".cache", "runtime-build", "dist"),
);
const dataRoot = path.resolve(process.env.EASYWORK_DATA_ROOT || path.join(root, "data"));
const archivedClientRoot = path.join(path.dirname(buildRoot), "shared-client");
const allowedOrigins = String(process.env.EASYWORK_ALLOWED_ORIGINS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const secrets = ["SESSION_SECRET", "MASTER_SECRET", "CURSOR_SECRET", "ARTIFACT_SECRET"]
  .every((name) => process.env[`EASYWORK_${name}`])
  ? {
      sessionSecret: process.env.EASYWORK_SESSION_SECRET,
      masterSecret: process.env.EASYWORK_MASTER_SECRET,
      cursorSecret: process.env.EASYWORK_CURSOR_SECRET,
      artifactSecret: process.env.EASYWORK_ARTIFACT_SECRET,
    }
  : undefined;

function assertPort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}

assertPort(publicPort, "EASYWORK_WEB_PORT");
assertPort(internalPort, "EASYWORK_WEB_INTERNAL_PORT");
if (publicPort === internalPort) {
  throw new Error("EasyWork public and renderer ports must be different");
}

async function publishBuildSnapshot() {
  const sourceRoot = path.join(root, "dist");
  await archiveClientAssets(path.join(sourceRoot, "client"), archivedClientRoot);
  if (buildRoot === sourceRoot) return sourceRoot;

  const parent = path.dirname(buildRoot);
  const snapshotRoot = path.join(parent, `dist-${Date.now()}-${process.pid}`);
  await mkdir(parent, { recursive: true });
  const previousEntries = await readdir(parent, { withFileTypes: true });
  await Promise.all(previousEntries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    if (!/^dist(?:-\d+-\d+|\.(?:staging|previous)-\d+)$/.test(entry.name)) return;
    await archiveClientAssets(path.join(parent, entry.name, "client"), archivedClientRoot);
    await rm(path.join(parent, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }));
  await rm(snapshotRoot, { recursive: true, force: true });
  await cp(sourceRoot, snapshotRoot, { recursive: true, force: true, preserveTimestamps: true });
  return snapshotRoot;
}

const publishedBuildRoot = await publishBuildSnapshot();
const clientRoot = path.join(publishedBuildRoot, "client");
const serveBuiltAsset = builtAssetHandler(clientRoot);
const serveArchivedAsset = builtAssetHandler(archivedClientRoot);

// Vinext remains an isolated renderer. The current process owns the only
// public listener and the complete EasyWork business runtime. It reads a
// published build snapshot so a later build can never mix new HTML with old
// hashed client assets in a running process.
const frontend = spawn(
  node,
  [rendererEntry],
  {
    cwd: root,
    env: {
      ...process.env,
      EASYWORK_BUILD_ROOT: publishedBuildRoot,
      EASYWORK_RENDERER_HOST: "127.0.0.1",
      EASYWORK_RENDERER_PORT: String(internalPort),
    },
    stdio: "inherit",
    shell: false,
  },
);

function proxyFrontend(request, response) {
  const headers = {
    ...request.headers,
    host: `127.0.0.1:${internalPort}`,
    "x-forwarded-host": request.headers.host || "",
    "x-forwarded-proto": String(request.headers["x-forwarded-proto"] || "http"),
  };
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: internalPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      if (!String(request.url || "").startsWith("/assets/")) {
        responseHeaders["cache-control"] = "no-cache, max-age=0, must-revalidate";
      }
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      error: { code: "WEB_UNAVAILABLE", message: "EasyWork 页面暂时不可用" },
    }));
  });
  request.pipe(upstream);
}

function waitForFrontend({ attempts = 120, intervalMs = 125 } = {}) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const tryConnect = () => {
      const socket = net.connect({ host: "127.0.0.1", port: internalPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        remaining -= 1;
        if (remaining <= 0) reject(new Error("EasyWork renderer did not start"));
        else setTimeout(tryConnect, intervalMs);
      });
    };
    tryConnect();
  });
}

let gateway;
let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!frontend.killed) frontend.kill();
  if (gateway) await gateway.close().catch(() => undefined);
  process.exit(exitCode);
}

frontend.once("exit", (code, signal) => {
  if (!shuttingDown) void shutdown(signal ? 1 : (code ?? 1));
});
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  await waitForFrontend();
  gateway = await createGatewayServer({
    runtimeOptions: { dataRoot, allowedOrigins, secrets },
    allowedOrigins,
    fallbackRequestHandler: async (request, response) => {
      if (await serveBuiltAsset(request, response)) return;
      if (String(request.url || "").startsWith("/assets/")) {
        if (await serveArchivedAsset(request, response)) return;
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Asset not found");
        return;
      }
      proxyFrontend(request, response);
    },
  });
  const address = await gateway.start({ host: "0.0.0.0", port: publicPort });
  console.log(`[easywork] Unified web, API and WebSocket entry at http://${address.host}:${address.port}`);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
