import path from "node:path";
import { fileURLToPath } from "node:url";

import { startProdServer } from "../node_modules/vinext/dist/server/prod-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.env.EASYWORK_BUILD_ROOT || path.join(root, "dist"));
const host = String(process.env.EASYWORK_RENDERER_HOST || "127.0.0.1");
const port = Number(process.env.EASYWORK_RENDERER_PORT || 8002);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("EASYWORK_RENDERER_PORT must be an integer between 1 and 65535");
}

await startProdServer({ host, port, outDir, purpose: "EasyWork renderer" });
