import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayServer } from "../gateway/core/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const publicPort = Number(process.env.EASYWORK_WEB_PORT || 8001);
const internalPort = Number(process.env.EASYWORK_WEB_INTERNAL_PORT || 8002);
const clientRoot = path.join(root, "dist", "client");
const dataRoot = path.resolve(process.env.EASYWORK_DATA_ROOT || path.join(root, "data"));
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

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

// Vinext remains an isolated renderer. The current process owns the only
// public listener and the complete EasyWork business runtime.
const frontend = spawn(
  node,
  [vinextCli, "start", "--hostname", "127.0.0.1", "--port", String(internalPort)],
  { cwd: root, env: process.env, stdio: "inherit", shell: false },
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

async function serveBuiltAsset(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://easywork.local").pathname);
  const absolutePath = path.resolve(clientRoot, `.${pathname}`);
  const clientPrefix = `${clientRoot}${path.sep}`;
  if (absolutePath !== clientRoot && !absolutePath.startsWith(clientPrefix)) return false;
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const extension = path.extname(absolutePath).toLowerCase();
  response.writeHead(200, {
    "content-type": contentTypes.get(extension) || "application/octet-stream",
    "content-length": info.size,
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache, max-age=0, must-revalidate",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(absolutePath).pipe(response);
  return true;
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
      proxyFrontend(request, response);
    },
  });
  const address = await gateway.start({ host: "0.0.0.0", port: publicPort });
  console.log(`[easywork] Unified web, API and WebSocket entry at http://${address.host}:${address.port}`);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
