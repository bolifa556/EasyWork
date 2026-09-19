import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";
import { ArtifactImageThumbnails } from "../gateway/core/artifacts/image-thumbnail.mjs";

test("thumbnails are regenerated for new versions and never cache a changed remote file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-thumbnails-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "image.json"), cache = new ArtifactImageThumbnails();
  const image = (background) => sharp({ create: { width: 900, height: 600, channels: 3, background } }).png().toBuffer();
  const before = await image("#faf8f2"), after = await image("#243d1b");
  const version = (id, bytes) => ({ id, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  const first = await cache.get({ filePath, version: version("v1", before), open: async () => Readable.from([before]) });
  const next = await cache.get({ filePath, version: version("v2", after), open: async () => Readable.from([after]) });
  assert.notDeepEqual(first, next);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).versionId, "v2");
  await assert.rejects(cache.get({ filePath, version: version("v3", before), open: async () => Readable.from([after]) }), (error) => error.code === "IMAGE_THUMBNAIL_SOURCE_CHANGED");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).versionId, "v2", "a failed read must not poison the existing cache");
  const recovered = await cache.get({ filePath, version: version("v3", before), open: async () => Readable.from([before]) });
  assert.deepEqual(recovered, first);
});
