const DOWNLOAD_INTENT_PATTERN = /(?:下载|download|文件(?:已|仍)?(?:确认)?存在|链接如下)/i;
const LIST_MARKER_PATTERN = /^(?:[-*+\u2022]\s+|\d+[.)]\s+)/;
const FILE_TOKEN_PATTERN = /[^\s/\\()[\]{}<>，。,:：;；"'`]+(?:\.tar\.(?:gz|bz2|xz|zst)|\.(?:txt|md|pdf|docx?|xlsx?|xlsm|ods|csv|tsv|pptx?|ppsx?|odp|png|jpe?g|gif|webp|svg|bmp|ico|tiff?|heic|wav|mp3|flac|aac|ogg|m4a|wma|aiff|mp4|mov|mkv|avi|webm|wmv|m4v|mpeg|zip|7z|rar|tar|gz|bz2|xz|tgz|zst|cab|sqlite|sqlite3|db|sql|json|ya?ml|toml|xml|html?|css|jsx?|tsx?|mjs|cjs|py|java|c|cc|cpp|h|hpp|rs|go|rb|php|swift|kt|sh|ps1|log|rtf|odt|pages|numbers|key|woff2?|ttf|otf|eot|exe|msi|dmg|pkg|deb|rpm|apk|appimage|iso|dwg|dxf|step|stp|iges|igs|stl|obj|3mf|blend|bin))(?![\p{L}\p{N}_.-])/giu;

function text(value) {
  return String(value ?? "").trim();
}

function lineCandidate(value) {
  return text(value).replace(LIST_MARKER_PATTERN, "").trim();
}

/**
 * Older adapter versions used the whole Markdown label as the Artifact name.
 * Prefer the filename token for presentation while keeping extension-less
 * names untouched. New captures are normalized by the gateway itself.
 */
export function artifactDisplayName(value) {
  const original = text(value) || "结果文件";
  const matches = [...original.matchAll(FILE_TOKEN_PATTERN)].map((match) => text(match[0]));
  return matches[0] || original;
}

function artifactNames(artifacts) {
  const names = new Set();
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const raw = text(artifact?.name);
    const display = artifactDisplayName(raw);
    if (raw) names.add(raw);
    if (display) names.add(display);
  }
  return names;
}

function downloadMetadataHeading(value) {
  return /^(?:#{1,6}\s*)?(?:\*{1,2})?(?:下载文件卡片|文件下载|下载链接)(?:\*{1,2})?\s*[:：]?$/i.test(text(value));
}

function lineMentionsArtifact(value, names) {
  const candidate = String(value ?? "");
  return [...names].some((name) => name && candidate.includes(name));
}

function stripDownloadMetadataBlocks(lines, names) {
  const removed = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!downloadMetadataHeading(lines[index])) continue;
    let cursor = index + 1;
    while (cursor < lines.length && !text(lines[cursor])) cursor += 1;
    const blockStart = cursor;
    let mentionsArtifact = false;
    while (cursor < lines.length && text(lines[cursor]) && cursor - blockStart < 12) {
      const candidate = lineCandidate(lines[cursor]);
      if (!LIST_MARKER_PATTERN.test(String(lines[cursor]).trim())
        && !/^(?:文件名|内容|类型|大小|下载|file|download)\s*[:：]/i.test(candidate)) break;
      mentionsArtifact ||= lineMentionsArtifact(lines[cursor], names);
      cursor += 1;
    }
    if (!mentionsArtifact) continue;
    for (let remove = index; remove < cursor; remove += 1) removed.add(remove);
  }
  return lines.filter((_line, index) => !removed.has(index));
}

/** Remove legacy filename-only placeholders once a real download card exists. */
export function stripArtifactPlaceholderLines(content, artifacts) {
  const names = artifactNames(artifacts);
  if (!names.size) return String(content ?? "");
  const lines = stripDownloadMetadataBlocks(String(content ?? "").split(/\r?\n/), names);
  return lines
    .filter((line) => !names.has(lineCandidate(line)))
    .filter((line) => !(lineMentionsArtifact(line, names) && /(?:下载|download|文件名)\s*[:：]?/i.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A historical Agent reply may contain only a filename because an older run
 * failed to emit its file:// marker. Reuse a same-conversation Artifact only
 * for an explicit download reply and an exact standalone filename match.
 */
export function referencedArtifactsForDownloadReply(content, artifacts) {
  const source = String(content ?? "");
  if (!DOWNLOAD_INTENT_PATTERN.test(source)) return [];
  const candidates = new Set(source.split(/\r?\n/).map(lineCandidate).filter(Boolean));
  const latestByName = new Map();
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const raw = text(artifact?.name);
    const display = artifactDisplayName(raw);
    if (!candidates.has(raw) && !candidates.has(display)) continue;
    const id = text(artifact?.id);
    if (!id) continue;
    latestByName.set(display || raw, artifact);
  }
  return [...latestByName.values()];
}
