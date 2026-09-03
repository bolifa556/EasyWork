import { ApiError, invariant } from "../errors.mjs";

function ocrEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  invariant(/^https?:\/\//i.test(normalized), "OCR_URL_INVALID", "OCR API URL 无效", { status: 400 });
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return /\/v1$/i.test(normalized) ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

function mineruEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  invariant(/^https?:\/\//i.test(normalized), "OCR_URL_INVALID", "OCR API URL 无效", { status: 400 });
  if (/\/file_parse$/i.test(normalized)) return normalized;
  return /\/mineru$/i.test(normalized) ? `${normalized}/file_parse` : `${normalized}/mineru/file_parse`;
}

function responseText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? String(part.text || "") : "")
    .filter(Boolean)
    .join("\n");
}

function normalizedOcrText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

function mineruMarkdown(body) {
  const direct = [body?.md_content, body?.markdown, body?.md, body?.content, body?.text]
    .map(normalizedOcrText)
    .find(Boolean);
  if (direct) return direct;

  const results = body?.results && typeof body.results === "object" ? body.results : null;
  if (results) {
    const pages = Object.values(results)
      .map((result) => normalizedOcrText(result?.md_content ?? result?.markdown ?? result?.md ?? result?.content ?? result?.text))
      .filter(Boolean);
    if (pages.length) return pages.join("\n\n");
  }

  for (const nested of [body?.data, body?.result, body?.output]) {
    if (nested && nested !== body) {
      const text = mineruMarkdown(nested);
      if (text) return text;
    }
  }
  return "";
}

function upstreamMessage(body, fallback) {
  const message = body?.error?.message ?? body?.detail ?? body?.message ?? body?.error;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 1000) : fallback;
}

export class OpenAIOcrAdapter {
  constructor({ baseUrl, apiKey, model, systemPrompt, inputPrompt, fetchImpl = globalThis.fetch, maxOutputTokens = 4096 } = {}) {
    invariant(typeof apiKey === "string" && apiKey.length > 0, "OCR_API_KEY_REQUIRED", "OCR API Key 未配置", { status: 503, retryable: true });
    invariant(typeof model === "string" && model.trim(), "OCR_MODEL_REQUIRED", "OCR 模型未配置", { status: 503, retryable: true });
    invariant(typeof systemPrompt === "string" && systemPrompt.trim(), "OCR_PROMPT_REQUIRED", "OCR 提示词未配置", { status: 500, expose: false });
    invariant(typeof inputPrompt === "function", "OCR_INPUT_PROMPT_REQUIRED", "OCR 输入提示词未配置", { status: 500, expose: false });
    invariant(typeof fetchImpl === "function", "OCR_FETCH_UNAVAILABLE", "OCR 请求缺少 fetch 实现", { status: 500, expose: false });
    invariant(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 256 && maxOutputTokens <= 32768, "OCR_OUTPUT_LIMIT_INVALID", "OCR 最大输出 Token 无效", { status: 500, expose: false });
    this.url = ocrEndpoint(baseUrl);
    this.apiKey = apiKey;
    this.model = model.trim();
    this.systemPrompt = systemPrompt.trim();
    this.inputPrompt = inputPrompt;
    this.fetchImpl = fetchImpl;
    this.maxOutputTokens = maxOutputTokens;
  }

  async extract({ content, mime = "image/png", filename = "image", pageNumber = null, signal } = {}) {
    const image = Buffer.from(content || "");
    invariant(image.length > 0, "OCR_IMAGE_EMPTY", "OCR 图片内容为空", { status: 422 });
    const label = pageNumber == null ? String(filename || "image") : `${String(filename || "PDF")} 第 ${pageNumber} 页`;
    const inputPrompt = await this.inputPrompt(label);
    invariant(typeof inputPrompt === "string" && inputPrompt.trim(), "OCR_INPUT_PROMPT_INVALID", "OCR 输入提示词无效", { status: 500, expose: false });
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: this.systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: inputPrompt.trim() },
              { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}`, detail: "high" } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: this.maxOutputTokens,
      }),
      signal,
    });
    let body = null;
    try { body = await response.json(); } catch { /* reported below */ }
    invariant(response.ok, "OCR_REQUEST_FAILED", body?.error?.message || `OCR API 返回 ${response.status}`, { status: 502, retryable: response.status >= 500 });
    const text = normalizedOcrText(responseText(body?.choices?.[0]?.message?.content));
    invariant(body?.choices?.[0]?.message, "OCR_RESPONSE_INVALID", "OCR API 返回结构无效", { status: 502 });
    return text;
  }
}

export class MinerUOcrAdapter {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
    invariant(typeof apiKey === "string" && apiKey.length > 0, "OCR_API_KEY_REQUIRED", "OCR API Key 未配置", { status: 503, retryable: true });
    invariant(typeof fetchImpl === "function", "OCR_FETCH_UNAVAILABLE", "OCR 请求缺少 fetch 实现", { status: 500, expose: false });
    invariant(typeof FormData === "function" && typeof Blob === "function", "OCR_MULTIPART_UNAVAILABLE", "当前运行环境不支持 MinerU 文件上传", { status: 500, expose: false });
    this.url = mineruEndpoint(baseUrl);
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async extract({ content, mime = "application/octet-stream", filename = "document", pageNumber = null, signal } = {}) {
    const document = Buffer.from(content || "");
    invariant(document.length > 0, "OCR_IMAGE_EMPTY", "OCR 文件内容为空", { status: 422 });
    const sourceName = String(filename || "document").trim() || "document";
    const extension = String(mime).toLowerCase() === "image/png" ? ".png" : "";
    const uploadName = pageNumber == null || !extension
      ? sourceName
      : `${sourceName.replace(/\.[^.]+$/, "")}-page-${pageNumber}${extension}`;
    const form = new FormData();
    form.append("files", new Blob([document], { type: String(mime || "application/octet-stream") }), uploadName);
    form.append("return_md", "true");
    form.append("response_format_zip", "false");

    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal,
      });
    } catch (error) {
      throw new ApiError("OCR_REQUEST_UNREACHABLE", "无法连接 MinerU OCR API", { status: 502, expose: true, retryable: true, cause: error });
    }
    let body = null;
    try { body = await response.json(); } catch { /* reported below */ }
    if (!response.ok) {
      throw new ApiError("OCR_REQUEST_FAILED", upstreamMessage(body, `MinerU OCR API 返回 ${response.status}`), {
        status: 502,
        expose: true,
        retryable: response.status >= 500,
        details: { upstreamStatus: response.status },
      });
    }
    invariant(body && typeof body === "object", "OCR_RESPONSE_INVALID", "MinerU OCR API 未返回有效 JSON", { status: 502, expose: true });
    const text = mineruMarkdown(body);
    invariant(text, "OCR_RESPONSE_INVALID", "MinerU OCR API 返回中没有 Markdown 内容", { status: 502, expose: true });
    return text;
  }
}

export { mineruEndpoint, ocrEndpoint };
