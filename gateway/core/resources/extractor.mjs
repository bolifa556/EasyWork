import path from "node:path";

import { invariant } from "../errors.mjs";

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|yaml|x-yaml|toml|csv))/i;
const IMAGE_MIME = /^image\//i;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

function imageMime(extension, fallback) {
  if (IMAGE_MIME.test(String(fallback || ""))) return String(fallback);
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".bmp") return "image/bmp";
  if ([".tif", ".tiff"].includes(extension)) return "image/tiff";
  return "image/png";
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

function documentMetadata(text, filename = "") {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n").map((line) => line.trim()).filter((line) => line && !/^\[第 \d+ 页\]$/.test(line));
  const headingLines = lines
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());
  const fallbackTitle = path.basename(String(filename || "文件"), path.extname(String(filename || ""))) || "文件";
  const firstLine = (headingLines[0] || lines[0] || fallbackTitle).replace(/^[-*+>]\s+/, "").trim();
  const title = firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`;
  const summarySource = lines.join(" ").replace(/\s+/g, " ").trim();
  const summary = summarySource.length > 320 ? `${summarySource.slice(0, 320).trimEnd()}…` : summarySource;
  const keywordCandidates = [
    fallbackTitle,
    ...headingLines.slice(0, 6),
    ...(normalized.match(/[A-Za-z][A-Za-z0-9_.-]{2,31}/g) || []),
  ];
  const keywords = [...new Set(keywordCandidates
    .flatMap((value) => String(value).split(/[\s,，、;；:：/\\|()[\]{}<>《》“”"']+/))
    .map((value) => value.trim())
    .filter((value) => value.length >= 2 && value.length <= 32))].slice(0, 10);
  return { title, summary, keywords };
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

function assertOcrExtractor(ocrExtractor) {
  invariant(typeof ocrExtractor?.extract === "function", "RESOURCE_OCR_NOT_CONFIGURED", "管理员尚未配置 OCR 工具，无法解析图片或扫描 PDF", { status: 409, retryable: false });
  return ocrExtractor;
}

async function ocrPdfPages(parser, pageNumbers, ocrExtractor, filename) {
  if (!pageNumbers.length) return new Map();
  const extractor = assertOcrExtractor(ocrExtractor);
  await extractor.assertConfigured?.();
  const screenshots = await parser.getScreenshot({
    partial: pageNumbers,
    desiredWidth: 1800,
    imageBuffer: true,
    imageDataUrl: false,
  });
  const recognized = new Map();
  for (const page of screenshots.pages || []) {
    const text = normalizeText(await extractor.extract({
      content: Buffer.from(page.data || []),
      filename,
      mime: "image/png",
      pageNumber: page.pageNumber,
    }));
    if (text) recognized.set(Number(page.pageNumber), text);
  }
  return recognized;
}

async function extractPdf(content, ocrExtractor, filename) {
  const imported = await import("pdf-parse");
  const Parser = imported.PDFParse || imported.default?.PDFParse;
  invariant(typeof Parser === "function", "RESOURCE_PDF_PARSER_UNAVAILABLE", "PDF 解析器不可用", { status: 500, expose: false });
  const parser = new Parser({ data: content });
  try {
    const native = await parser.getText({ pageJoiner: "" });
    const nativePages = new Map((native.pages || []).map((page) => [Number(page.num), normalizeText(page.text)]));
    const weakPages = [...nativePages.entries()].filter(([, text]) => text.replace(/\s/g, "").length < 8).map(([pageNumber]) => pageNumber);
    let ocrPages = [];
    if (weakPages.length) {
      try {
        const images = await parser.getImage({ partial: weakPages, imageThreshold: 96, imageBuffer: false, imageDataUrl: false });
        ocrPages = (images.pages || []).filter((page) => Array.isArray(page.images) && page.images.length > 0).map((page) => Number(page.pageNumber));
      } catch {
        if (!normalizeText(native.text)) ocrPages = weakPages;
      }
    }
    const recognized = await ocrPdfPages(parser, ocrPages, ocrExtractor, filename);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= Number(native.total || 0); pageNumber += 1) {
      const text = recognized.get(pageNumber) || nativePages.get(pageNumber) || "";
      if (text) pages.push(`[第 ${pageNumber} 页]\n${text}`);
    }
    return { text: normalizeText(pages.join("\n\n")), extraction: ocrPages.length ? "pdf+ocr" : "pdf" };
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
  constructor({ ocrExtractor = null, visionExtractor = null, maxCharacters = 3_600, overlapCharacters = 360 } = {}) {
    invariant(Number.isSafeInteger(maxCharacters) && maxCharacters >= 512 && maxCharacters <= 32_000, "RESOURCE_CHUNK_SIZE_INVALID", "分块大小无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(overlapCharacters) && overlapCharacters >= 0 && overlapCharacters < maxCharacters, "RESOURCE_CHUNK_OVERLAP_INVALID", "分块重叠无效", { status: 500, expose: false });
    this.ocrExtractor = ocrExtractor || visionExtractor;
    this.maxCharacters = maxCharacters;
    this.overlapCharacters = overlapCharacters;
  }

  async preflight({ filename, mime }) {
    const extension = path.extname(String(filename || "")).toLowerCase();
    if (IMAGE_MIME.test(String(mime || "")) || IMAGE_EXTENSIONS.has(extension)) {
      const extractor = assertOcrExtractor(this.ocrExtractor);
      await extractor.assertConfigured?.();
    }
  }

  async extract({ content, filename, mime }) {
    const extension = path.extname(filename).toLowerCase();
    let text;
    let extraction = "text";
    if (TEXT_MIME.test(mime) || [".md", ".txt", ".csv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".js", ".ts", ".py", ".r", ".sh"].includes(extension)) {
      text = normalizeText(Buffer.from(content).toString("utf8"));
    } else if (mime === "application/pdf" || extension === ".pdf") {
      const result = await extractPdf(Buffer.from(content), this.ocrExtractor, filename);
      extraction = result.extraction;
      text = result.text;
    } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || extension === ".docx") {
      extraction = "docx";
      text = await extractDocx(Buffer.from(content));
    } else if (IMAGE_MIME.test(mime) || IMAGE_EXTENSIONS.has(extension)) {
      const extractor = assertOcrExtractor(this.ocrExtractor);
      await extractor.assertConfigured?.();
      extraction = "ocr";
      text = normalizeText(await extractor.extract({ content: Buffer.from(content), filename, mime: imageMime(extension, mime) }));
    } else {
      invariant(false, "RESOURCE_TYPE_UNSUPPORTED", "该文件类型暂不支持建立索引", { status: 415, details: { mime, extension } });
    }
    invariant(text.length > 0, "RESOURCE_TEXT_EMPTY", "文件中没有可用于索引的文本", { status: 422 });
    return {
      schemaVersion: 1,
      extraction,
      text,
      characters: text.length,
      metadata: documentMetadata(text, filename),
      chunks: chunkText(text, { maxCharacters: this.maxCharacters, overlapCharacters: this.overlapCharacters }),
    };
  }
}

export { chunkText, documentMetadata };
