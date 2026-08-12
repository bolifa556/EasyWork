import crypto from "node:crypto";

import { invariant } from "../errors.mjs";

function embeddingEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  invariant(/^https?:\/\//i.test(normalized), "EMBEDDING_URL_INVALID", "Embedding API URL 无效", { status: 400 });
  return /\/embeddings$/i.test(normalized) ? normalized : `${normalized}/v1/embeddings`;
}

function cosine(left, right) {
  invariant(Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.length > 0, "EMBEDDING_DIMENSION_MISMATCH", "Embedding 向量维度不一致", { status: 500, expose: false });
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    invariant(Number.isFinite(a) && Number.isFinite(b), "EMBEDDING_VECTOR_INVALID", "Embedding 向量包含无效值", { status: 502 });
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export class OpenAIEmbeddingAdapter {
  constructor({ baseUrl, apiKey, model, fetchImpl = fetch, batchSize = 32, dimensions = null, profileId = null }) {
    invariant(typeof apiKey === "string" && apiKey.length > 0, "EMBEDDING_API_KEY_REQUIRED", "Embedding API Key 未配置", { status: 503, retryable: true });
    invariant(typeof model === "string" && model.trim(), "EMBEDDING_MODEL_REQUIRED", "Embedding 模型未配置", { status: 503, retryable: true });
    invariant(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 256, "EMBEDDING_BATCH_SIZE_INVALID", "Embedding 批量大小无效", { status: 500, expose: false });
    this.url = embeddingEndpoint(baseUrl);
    this.apiKey = apiKey;
    this.model = model.trim();
    this.fetchImpl = fetchImpl;
    this.batchSize = batchSize;
    this.dimensions = dimensions;
    this.profileId = profileId || `embedding_${crypto.createHash("sha256").update(`${this.url}\0${this.model}\0${dimensions || "auto"}`).digest("hex").slice(0, 24)}`;
  }

  async #vectors(inputs) {
    const output = [];
    for (let offset = 0; offset < inputs.length; offset += this.batchSize) {
      const batch = inputs.slice(offset, offset + this.batchSize);
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: batch, ...(this.dimensions ? { dimensions: this.dimensions } : {}) }),
      });
      let body;
      try { body = await response.json(); } catch { body = null; }
      invariant(response.ok && Array.isArray(body?.data), "EMBEDDING_REQUEST_FAILED", body?.error?.message || `Embedding API 返回 ${response.status}`, { status: 502, retryable: response.status >= 500 });
      const ordered = [...body.data].sort((left, right) => Number(left.index) - Number(right.index));
      invariant(ordered.length === batch.length, "EMBEDDING_RESPONSE_INVALID", "Embedding API 返回数量不一致", { status: 502 });
      output.push(...ordered.map((entry) => entry.embedding));
    }
    return output;
  }

  async embed({ parsed }) {
    const chunks = Array.isArray(parsed?.chunks) ? parsed.chunks : [];
    invariant(chunks.length > 0, "EMBEDDING_INPUT_EMPTY", "没有可向量化的文本分块", { status: 422 });
    const vectors = await this.#vectors(chunks.map((chunk) => chunk.text));
    return {
      profileId: this.profileId,
      reference: {
        schemaVersion: 1,
        model: this.model,
        dimensions: vectors[0]?.length || 0,
        chunks: chunks.map((chunk, index) => ({ chunkId: chunk.chunkId, text: chunk.text, vector: vectors[index] })),
      },
    };
  }

  async search({ query, candidates, limit }) {
    const [queryVector] = await this.#vectors([query]);
    const scored = [];
    for (const candidate of candidates) {
      for (const chunk of candidate.vectorReference?.chunks || []) {
        scored.push({
          resourceVersionId: candidate.resourceVersionId,
          chunkId: chunk.chunkId,
          text: chunk.text,
          score: cosine(queryVector, chunk.vector),
        });
      }
    }
    return scored.sort((left, right) => right.score - left.score).slice(0, limit);
  }
}

export { cosine, embeddingEndpoint };
