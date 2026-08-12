import path from "node:path";

import { invariant } from "../errors.mjs";

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|yaml|x-yaml|toml|csv))/i;
const IMAGE_MIME = /^image\//i;

function normalizeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

function chunkText(text, { maxCharacters, overlapCharacters }) {
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxCharacters);
    if (end < text.length) {
      const searchStart = Math.max(start + Math.floor(maxCharacters * 0.55), end - 600);
      const boundary = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("。", end), text.lastIndexOf("\n", end));
      if (boundary >= searchStart) end = boundary + 1;
    }
    const value = text.slice(start, end).trim();
    if (value) chunks.push({ chunkId: `chunk_${String(chunks.length + 1).padStart(6, "0")}`, text: value, start, end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapCharacters);
  }
  return chunks;
}

async function extractPdf(content) {
  const imported = await import("pdf-parse");
  if (typeof imported.default === "function") return normalizeText((await imported.default(content)).text);
  const Parser = imported.PDFParse || imported.default?.PDFParse;
  invariant(typeof Parser === "function", "RESOURCE_PDF_PARSER_UNAVAILABLE", "PDF 解析器不可用", { status: 500, expose: false });
  const parser = new Parser({ data: content });
  try {
    return normalizeText((await parser.getText()).text);
  } finally {
    await parser.destroy?.();
  }
}

async function extractDocx(content) {
  const mammoth = await import("mammoth");
  const result = await (mammoth.default || mammoth).extractRawText({ buffer: content });
  return normalizeText(result.value);
}

export class DefaultResourceExtractor {
  constructor({ visionExtractor = null, maxCharacters = 3_600, overlapCharacters = 360 } = {}) {
    invariant(Number.isSafeInteger(maxCharacters) && maxCharacters >= 512 && maxCharacters <= 32_000, "RESOURCE_CHUNK_SIZE_INVALID", "分块大小无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(overlapCharacters) && overlapCharacters >= 0 && overlapCharacters < maxCharacters, "RESOURCE_CHUNK_OVERLAP_INVALID", "分块重叠无效", { status: 500, expose: false });
    this.visionExtractor = visionExtractor;
    this.maxCharacters = maxCharacters;
    this.overlapCharacters = overlapCharacters;
  }

  async extract({ content, filename, mime }) {
    const extension = path.extname(filename).toLowerCase();
    let text;
    let extraction = "text";
    if (TEXT_MIME.test(mime) || [".md", ".txt", ".csv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".js", ".ts", ".py", ".r", ".sh"].includes(extension)) {
      text = normalizeText(Buffer.from(content).toString("utf8"));
    } else if (mime === "application/pdf" || extension === ".pdf") {
      extraction = "pdf";
      text = await extractPdf(Buffer.from(content));
    } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || extension === ".docx") {
      extraction = "docx";
      text = await extractDocx(Buffer.from(content));
    } else if (IMAGE_MIME.test(mime)) {
      invariant(typeof this.visionExtractor?.extract === "function", "RESOURCE_IMAGE_EXTRACTOR_UNAVAILABLE", "图片需要可用的视觉模型才能建立索引", { status: 503, retryable: true });
      extraction = "vision";
      text = normalizeText(await this.visionExtractor.extract({ content: Buffer.from(content), filename, mime }));
    } else {
      invariant(false, "RESOURCE_TYPE_UNSUPPORTED", "该文件类型暂不支持建立索引", { status: 415, details: { mime, extension } });
    }
    invariant(text.length > 0, "RESOURCE_TEXT_EMPTY", "文件中没有可用于索引的文本", { status: 422 });
    return {
      schemaVersion: 1,
      extraction,
      text,
      characters: text.length,
      chunks: chunkText(text, { maxCharacters: this.maxCharacters, overlapCharacters: this.overlapCharacters }),
    };
  }
}

export { chunkText };
