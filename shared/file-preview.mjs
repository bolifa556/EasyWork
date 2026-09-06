// Entry-point availability only. The Preview service inspects the file and
// chooses the actual viewer; a filename never bypasses those content checks.
const PREVIEW_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "json", "csv", "tsv", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg",
  "yaml", "yml", "toml", "ini", "py", "js", "ts", "tsx", "jsx", "css", "html", "sh", "ps1", "r", "cpp", "c",
  "h", "java", "rs", "go", "sql",
]);

export function fileTypeLabel({ name = "", mime = "" } = {}) {
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  const labels = { md: "Markdown", markdown: "Markdown", txt: "文本", doc: "Word", docx: "Word", xls: "Excel", xlsx: "Excel", ppt: "PowerPoint", pptx: "PowerPoint" };
  if (extension) return labels[extension] || extension.toUpperCase();
  if (/^application\/pdf(?:;|$)/i.test(mime)) return "PDF";
  if (/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(mime)) return "JSON";
  if (/^text\//i.test(mime)) return "文本";
  if (/^image\//i.test(mime)) return "图片";
  if (/^audio\//i.test(mime)) return "音频";
  if (/^video\//i.test(mime)) return "视频";
  return "文件";
}

export function canPreviewFile({ name = "", mime = "" } = {}) {
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  return !extension || PREVIEW_EXTENSIONS.has(extension)
    || /^(?:text\/|image\/|application\/(?:pdf|json|[^;]+\+json)(?:;|$))/i.test(mime);
}
