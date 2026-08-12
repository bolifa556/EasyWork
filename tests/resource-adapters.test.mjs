import assert from "node:assert/strict";
import test from "node:test";

import { DefaultResourceExtractor, OpenAIEmbeddingAdapter } from "../gateway/core/resources/index.mjs";

test("default extractor keeps folder filename metadata outside text and produces stable overlapping chunks", async () => {
  const extractor = new DefaultResourceExtractor({ maxCharacters: 512, overlapCharacters: 64 });
  const parsed = await extractor.extract({ content: Buffer.from(`${"段落内容。".repeat(140)}\n\n结束`), filename: "notes.md", mime: "text/markdown" });
  assert.equal(parsed.extraction, "text");
  assert.ok(parsed.chunks.length >= 2);
  assert.equal(parsed.chunks[0].chunkId, "chunk_000001");
  assert.equal(parsed.text.endsWith("结束"), true);
});

test("image extraction is explicit and does not silently index binary bytes", async () => {
  const extractor = new DefaultResourceExtractor();
  await assert.rejects(() => extractor.extract({ content: Buffer.from([1, 2, 3]), filename: "image.png", mime: "image/png" }), (error) => error?.code === "RESOURCE_IMAGE_EXTRACTOR_UNAVAILABLE");
  const vision = new DefaultResourceExtractor({ visionExtractor: { async extract() { return "图片中的实验结果"; } } });
  assert.equal((await vision.extract({ content: Buffer.from([1]), filename: "image.png", mime: "image/png" })).extraction, "vision");
});

test("OpenAI embedding adapter batches authorized text and ranks chunks with cosine similarity", async () => {
  const calls = [];
  const adapter = new OpenAIEmbeddingAdapter({
    baseUrl: "https://api.example.test",
    apiKey: "test-secret",
    model: "embedding-model",
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body);
      const vector = (text) => text.includes("GPU") ? [1, 0] : [0, 1];
      return { ok: true, async json() { return { data: body.input.map((text, index) => ({ index, embedding: vector(text) })) }; } };
    },
  });
  const embedded = await adapter.embed({ parsed: { chunks: [{ chunkId: "a", text: "GPU resource" }, { chunkId: "b", text: "document" }] } });
  const result = await adapter.search({ query: "GPU", candidates: [{ resourceVersionId: "version_a", vectorReference: embedded.reference }], limit: 1 });
  assert.equal(result[0].chunkId, "a");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls).includes("test-secret"), false);
});
