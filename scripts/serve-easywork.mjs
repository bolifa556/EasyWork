import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const vinextRunner = path.join(root, "scripts", "run-vinext.mjs");
const publicPort = Number(process.env.EASYWORK_WEB_PORT || 3000);
const internalPort = Number(process.env.EASYWORK_WEB_INTERNAL_PORT || publicPort + 1);
const gatewayPort = Number(process.env.EASYWORK_GATEWAY_PORT || 8789);
const clientRoot = path.join(root, "dist", "client");

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

const frontend = spawn(
  node,
  [vinextRunner, "start", "--hostname", "127.0.0.1", "--port", String(internalPort)],
  { cwd: root, env: process.env, stdio: "inherit", shell: false },
);

function targetFor(url = "/") {
  return url.startsWith("/api/") || url === "/api" || url.startsWith("/easywork-ws")
    ? { port: gatewayPort, service: "gateway" }
    : { port: internalPort, service: "web" };
}

function proxyHttp(request, response) {
  const target = targetFor(request.url);
  const headers = {
    ...request.headers,
    host: `127.0.0.1:${target.port}`,
    "x-forwarded-host": request.headers.host || "",
    "x-forwarded-proto": "http",
  };
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: target.port,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      if (target.service === "web" && !String(request.url || "").startsWith("/assets/")) {
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
      error: {
        code: target.service === "gateway" ? "GATEWAY_UNAVAILABLE" : "WEB_UNAVAILABLE",
        message: target.service === "gateway" ? "EasyWork 网关暂时不可用" : "EasyWork 页面暂时不可用",
      },
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
    // Production assets use content hashes and can be immutable. Every other
    // response must be revalidated so an obsolete app shell cannot keep
    // referencing bundles removed by the latest clean build.
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache, max-age=0, must-revalidate",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(absolutePath).pipe(response);
  return true;
}

function proxyUpgrade(request, browserSocket, head) {
  const target = targetFor(request.url);
  if (target.service !== "gateway") {
    browserSocket.destroy();
    return;
  }
  browserSocket.pause();
  const gatewaySocket = net.connect({ host: "127.0.0.1", port: target.port });
  const close = () => {
    if (!browserSocket.destroyed) browserSocket.destroy();
    if (!gatewaySocket.destroyed) gatewaySocket.destroy();
  };
  gatewaySocket.once("connect", () => {
    const forwardedHeaders = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name.toLowerCase() === "host") continue;
      forwardedHeaders.push(`${name}: ${value}`);
    }
    forwardedHeaders.push(`Host: 127.0.0.1:${target.port}`);
    gatewaySocket.write(
      `${request.method || "GET"} ${request.url || "/easywork-ws"} HTTP/${request.httpVersion}\r\n${forwardedHeaders.join("\r\n")}\r\n\r\n`,
    );
    if (head.length) gatewaySocket.write(head);
    browserSocket.pipe(gatewaySocket);
    gatewaySocket.pipe(browserSocket);
    browserSocket.resume();
  });
  browserSocket.once("error", close);
  gatewaySocket.once("error", close);
}

function waitForFrontend({ attempts = 80, intervalMs = 125 } = {}) {
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
        if (remaining <= 0) reject(new Error("EasyWork production server did not start"));
        else setTimeout(tryConnect, intervalMs);
      });
    };
    tryConnect();
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (await serveBuiltAsset(request, response)) return;
    proxyHttp(request, response);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("EasyWork 静态资源读取失败");
    console.error(error);
  }
});
server.on("upgrade", proxyUpgrade);

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(exitCode));
  frontend.kill();
  setTimeout(() => process.exit(exitCode), 2_000).unref();
}

frontend.once("exit", (code, signal) => {
  if (!shuttingDown) shutdown(signal ? 1 : (code ?? 1));
});
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

try {
  await waitForFrontend();
  server.listen(publicPort, "0.0.0.0", () => {
    console.log(`[easywork] Web and same-origin gateway available at http://0.0.0.0:${publicPort}`);
  });
} catch (error) {
  console.error(error);
  shutdown(1);
}
