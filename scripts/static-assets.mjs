import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipBytes = promisify(gzip);
const compressible = new Set([".js", ".css", ".json", ".svg", ".html"]);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".gif", "image/gif"], [".ico", "image/x-icon"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".map", "application/json; charset=utf-8"], [".png", "image/png"], [".svg", "image/svg+xml"],
  [".webp", "image/webp"], [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"],
]);

export async function archiveClientAssets(clientRoot, archiveRoot) {
  const source = path.join(clientRoot, "assets");
  if (!(await stat(source).catch(() => null))?.isDirectory()) return;
  await mkdir(archiveRoot, { recursive: true });
  // Hashed files are immutable. Open tabs can request lazy chunks from an
  // earlier deployment, including that chunk's CSS and transitive imports.
  await cp(source, path.join(archiveRoot, "assets"), { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
}

export async function precompressClient(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { await precompressClient(file); continue; }
    if (!entry.isFile() || !compressible.has(path.extname(file))) continue;
    const bytes = await readFile(file);
    if (bytes.length < 1024) continue;
    const [br, gz] = await Promise.all([
      brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
      gzipBytes(bytes, { level: 6 }),
    ]);
    await Promise.all([
      ...(br.length < bytes.length ? [writeFile(`${file}.br`, br)] : []),
      ...(gz.length < bytes.length ? [writeFile(`${file}.gz`, gz)] : []),
    ]);
  }
}

function acceptedEncodings(header) {
  const qualities = new Map();
  for (const item of String(header || "").toLowerCase().split(",")) {
    const [name, ...parameters] = item.trim().split(";");
    const q = parameters.map((value) => /^\s*q\s*=\s*(.+)\s*$/.exec(value)).find(Boolean);
    const quality = q ? Number(q[1]) : 1;
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = (name) => qualities.get(name) ?? qualities.get("*") ?? 0;
  return ["br", "gzip", "identity"].map((name) => ({ name, q: name === "identity"
    ? qualities.get(name) ?? (qualities.get("*") === 0 ? 0 : 0.001)
    : quality(name) })).filter(({ q }) => q > 0).sort((left, right) => right.q - left.q).map(({ name }) => name);
}

export function builtAssetHandler(clientRoot) {
  const root = path.resolve(clientRoot);
  return async function serveBuiltAsset(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url || "/", "http://easywork.local").pathname); }
    catch { return false; }
    const absolutePath = path.resolve(root, `.${pathname}`);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) return false;
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile()) return false;
    const extension = path.extname(absolutePath).toLowerCase();
    let selected = null;
    for (const encoding of acceptedEncodings(request.headers["accept-encoding"])) {
      if (encoding === "identity") { selected = { file: absolutePath, size: info.size, encoding: null }; break; }
      if (!compressible.has(extension)) continue;
      const file = `${absolutePath}.${encoding === "gzip" ? "gz" : "br"}`;
      const compressed = await stat(file).catch(() => null);
      if (compressed?.isFile() && compressed.mtimeMs >= info.mtimeMs) {
        selected = { file, size: compressed.size, encoding }; break;
      }
    }
    if (!selected) { response.writeHead(406, { vary: "Accept-Encoding" }); response.end(); return true; }
    response.writeHead(200, {
      "content-type": contentTypes.get(extension) || "application/octet-stream",
      "content-length": selected.size,
      "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache, max-age=0, must-revalidate",
      vary: "Accept-Encoding",
      ...(selected.encoding ? { "content-encoding": selected.encoding } : {}),
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(selected.file).on("error", (error) => response.destroy(error)).pipe(response);
    return true;
  };
}
