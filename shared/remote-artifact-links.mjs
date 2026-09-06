import { unified } from "unified";
import remarkParse from "remark-parse";

const markdownParser = unified().use(remarkParse);

// Only decoration next to an extracted file link is removed. Other emoji in
// the answer (or inside code) remain ordinary user-visible content.
export const FILE_LINK_DECORATION = /[📄📃📑📁📂🗂🗃🗄📎🔗📥⬇👇👉💾📝🖼🎵🎶🎧📦\uFE0E\uFE0F]/gu;

export function stripFileLinkDecoration(value) {
  return String(value || "").replace(FILE_LINK_DECORATION, "");
}

export function remoteArtifactPath(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate || candidate.includes("\0")) return "";
  if (!candidate.startsWith("file://")) return candidate.startsWith("/") ? candidate : "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return "";
    const path = decodeURIComponent(url.pathname);
    return path.startsWith("/") && !path.includes("\0") ? path : "";
  } catch {
    return "";
  }
}

function artifactNameFromLink(label, artifactPath) {
  const fallback = artifactPath.split("/").filter(Boolean).at(-1);
  if (fallback) return fallback;
  const cleaned = String(label || "").replace(/[*_`]/g, "").trim();
  return cleaned && cleaned.length <= 255 ? cleaned : "download";
}

function cleanLinkedArtifactLine(cleaned) {
  const normalized = stripFileLinkDecoration(cleaned)
    // A model may emphasize the Markdown link itself. Once the link becomes
    // an Artifact card those now-empty emphasis markers must disappear too.
    .replace(/(?:\*{2,}|_{2,}|~~)/g, "")
    .replace(/[ \t]+([，。；：,.!?])/g, "$1")
    .trimEnd();
  if (/^\s*(?:[-*+]\s*|\d+[.)]\s*)?$/.test(normalized)) return "";
  if (/^\s*(?:[-*+]\s*|\d+[.)]\s*)?(?:下载|download)\s*[:：]?\s*$/i.test(normalized)) return "";
  return /[:：]\s*$/.test(normalized) ? normalized.replace(/[:：]\s*$/, "。") : normalized;
}


// One parser defines both artifact extraction and timeline final-answer identity.
export function parseRemoteArtifactLinks(value) {
  const original = typeof value === "string" ? value : "";
  const tree = markdownParser.parse(original);
  const definitions = new Map();
  const walk = (node, visit) => { visit(node); for (const child of node.children || []) walk(child, visit); };
  walk(tree, (node) => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  const artifacts = [];
  const ranges = [];
  walk(tree, (node) => {
    if (!["link", "linkReference"].includes(node.type)) return;
    const definition = node.type === "linkReference" ? definitions.get(node.identifier) : null;
    const target = node.type === "link" ? node.url : definition?.url;
    if (!String(target || "").startsWith("file://")) return;
    const artifactPath = remoteArtifactPath(target);
    if (!artifactPath) return;
    artifacts.push({ source: "remote", path: artifactPath, name: artifactNameFromLink("", artifactPath), kind: "file" });
    ranges.push([node.position.start.offset, node.position.end.offset]);
    if (definition) ranges.push([definition.position.start.offset, definition.position.end.offset]);
  });
  let withoutLinks = original;
  // Preserve line positions while removing multi-line links. Repeated uses of
  // one reference definition must remove its source range exactly once.
  const uniqueRanges = [...new Map(ranges.map((range) => [range.join(":"), range])).values()];
  for (const [start, end] of uniqueRanges.sort((a, b) => b[0] - a[0])) {
    const newlines = (original.slice(start, end).match(/\n/g) || []).join("");
    withoutLinks = withoutLinks.slice(0, start) + newlines + withoutLinks.slice(end);
  }
  const originalLines = original.split(/\r?\n/);
  const cleaned = withoutLinks.split(/\r?\n/)
    .map((line, index) => ({ original: originalLines[index] || "", cleaned: line === originalLines[index] ? line : cleanLinkedArtifactLine(line) }))
    // Keep intentional Markdown paragraph/list boundaries. Only discard a
    // non-empty line when extracting its file link made that line empty.
    .filter((line) => line.cleaned !== "" || line.original.trim() === "")
    .map((line) => line.cleaned)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { original, artifacts, cleaned: cleaned || (artifacts.length ? "文件已准备好下载。" : original) };
}
