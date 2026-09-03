import vinext from "vinext";
import { defineConfig } from "vite";
import path from "node:path";
import net from "node:net";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [],
  r2_buckets: [],
};

export default defineConfig(async () => {
  const gatewayPort = Number(process.env.EASYWORK_GATEWAY_PORT || 8789);
  const publicPort = Number(process.env.EASYWORK_WEB_PORT || 8001);
  const gatewayTarget = `http://127.0.0.1:${gatewayPort}`;
  const installWebsocketTunnel = (server: {
    httpServer: import("node:http").Server | null;
  }) => {
    return () => {
      const httpServer = server.httpServer;
      if (!httpServer) return;
      const existingUpgradeListeners = httpServer.rawListeners("upgrade");
      httpServer.removeAllListeners("upgrade");
      httpServer.on("upgrade", (request, browserSocket, head) => {
        const requestUrl = new URL(
          request.url || "/",
          `http://${request.headers.host || "localhost"}`,
        );
        if (requestUrl.pathname !== "/easywork-ws") {
          for (const listener of existingUpgradeListeners) {
            listener.call(httpServer, request, browserSocket, head);
          }
          return;
        }

        browserSocket.pause();
        const gatewaySocket = net.connect({
          host: "127.0.0.1",
          port: gatewayPort,
        });
        const closeTunnel = () => {
          if (!browserSocket.destroyed) browserSocket.destroy();
          if (!gatewaySocket.destroyed) gatewaySocket.destroy();
        };
        gatewaySocket.once("connect", () => {
          const headers = request.rawHeaders
            .reduce<string[]>((lines, value, index, raw) => {
              if (index % 2 === 0) lines.push(`${value}: ${raw[index + 1]}`);
              return lines;
            }, [])
            .join("\r\n");
          gatewaySocket.write(
            `${request.method || "GET"} ${request.url || "/easywork-ws"} HTTP/${
              request.httpVersion
            }\r\n${headers}\r\n\r\n`,
          );
          if (head.length) gatewaySocket.write(head);
          browserSocket.pipe(gatewaySocket);
          gatewaySocket.pipe(browserSocket);
          browserSocket.resume();
        });
        browserSocket.once("error", closeTunnel);
        gatewaySocket.once("error", closeTunnel);
      });
    };
  };
  const websocketTunnel = {
    name: "easywork-websocket-tunnel",
    configureServer: installWebsocketTunnel,
  };
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= path.join(".cache", "wrangler", "logs");
  process.env.MINIFLARE_REGISTRY_PATH ??= path.join(
    ".cache",
    "wrangler",
    "registry",
  );

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "0.0.0.0",
      port: publicPort,
      strictPort: true,
      hmr: false,
      watch: {
        ignored: ["**/.cache/**"],
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
      proxy: {
        "/api": {
          target: gatewayTarget,
          changeOrigin: true,
        },
        "/easywork-ws": {
          target: gatewayTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    plugins: [
      websocketTunnel,
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
