import crypto from "node:crypto";
import fs from "node:fs/promises";
import sharp from "sharp";
import { invariant } from "../errors.mjs";
import { writeJsonAtomic } from "./storage.mjs";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export class ArtifactImageThumbnails {
  #pending = new Map();

  async get({ filePath, version, open }) {
    const key = `${filePath}:${version.id}:${version.sha256}`;
    if (this.#pending.has(key)) return this.#pending.get(key);
    const pending = this.#load({ filePath, version, open });
    this.#pending.set(key, pending);
    try { return await pending; }
    finally { this.#pending.delete(key); }
  }

  async #load({ filePath, version, open }) {
    try {
      const cached = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (cached.versionId === version.id && cached.sourceSha256 === version.sha256 && typeof cached.content === "string") {
        const content = Buffer.from(cached.content, "base64");
        if (content.length && crypto.createHash("sha256").update(content).digest("hex") === cached.sha256) return content;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    invariant(version.size <= MAX_IMAGE_BYTES, "IMAGE_THUMBNAIL_TOO_LARGE", "图片超过缩略图读取上限，请下载原图", { status: 413 });
    const stream = await open();
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      invariant(size <= version.size && size <= MAX_IMAGE_BYTES, "IMAGE_THUMBNAIL_SOURCE_CHANGED", "图片大小已变化，请重新交付图片", { status: 409 });
      chunks.push(bytes);
    }
    const original = Buffer.concat(chunks);
    invariant(size === version.size && crypto.createHash("sha256").update(original).digest("hex") === version.sha256,
      "IMAGE_THUMBNAIL_SOURCE_CHANGED", "图片内容已变化，请重新交付图片", { status: 409 });
    const content = await sharp(original, { limitInputPixels: 80_000_000 })
      .rotate().resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
    await writeJsonAtomic(filePath, { schemaVersion: 1, versionId: version.id, sourceSha256: version.sha256,
      sha256: crypto.createHash("sha256").update(content).digest("hex"), content: content.toString("base64") });
    return content;
  }
}
