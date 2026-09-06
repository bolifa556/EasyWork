import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function digest(file, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function downloadVerified({ url, destination, sha256, integrity, size }) {
  const [algorithm, expected, encoding] = sha256
    ? ["sha256", sha256, "hex"]
    : [integrity?.split("-")[0], integrity?.slice(integrity.indexOf("-") + 1), "base64"];
  if (!expected || !["sha256", "sha512"].includes(algorithm)) throw new Error(`Missing checksum: ${url}`);
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid SHA-256: ${url}`);
  if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) throw new Error(`Invalid artifact size: ${url}`);
  if (!url.startsWith("https://")) throw new Error("Artifact downloads require HTTPS");
  if (await digest(destination, algorithm, encoding).catch(() => null) === expected) {
    if (size !== undefined && (await stat(destination)).size !== size) throw new Error(`Size mismatch: ${url}`);
    return destination;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${randomUUID()}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`[download] ${path.basename(destination)} (attempt ${attempt})`);
      const response = await fetch(url, { headers: { "User-Agent": "EasyWork-Agent-Artifact-Updater" }, signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      if (size !== undefined && (await stat(partial)).size !== size) throw new Error(`Size mismatch: ${url}`);
      if (await digest(partial, algorithm, encoding) !== expected) throw new Error(`Checksum mismatch: ${url}`);
      await rename(partial, destination);
      return destination;
    } catch (error) {
      await rm(partial, { force: true });
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}
