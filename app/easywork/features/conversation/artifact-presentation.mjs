import { parseRemoteArtifactLinks, stripFileLinkDecoration } from "../../../../shared/remote-artifact-links.mjs";

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
  // A real basename may contain spaces. Only shorten a legacy label when it
  // contains a description after the filename, not part of the filename itself.
  if (matches.length && original.endsWith(matches.at(-1))) return original;
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

const eventPayload = (event) => event.payload?.event || event.payload || {};

export function conversationArtifactCards(events = [], artifacts = []) {
  const byId = new Map();
  const unavailable = new Set();
  for (const artifact of artifacts) {
    if (["active", "pinned"].includes(artifact.lifecycle)) byId.set(artifact.id, { ...artifact, name: artifactDisplayName(artifact.name) });
    else unavailable.add(artifact.id);
  }
  for (const event of events) {
    if (event.kind !== "artifact") continue;
    const record = eventPayload(event), artifact = record.artifact || {};
    const id = String(record.artifactId || artifact.id || (record.failure?.message ? `failed:${event.eventId}` : ""));
    if (!id || unavailable.has(id)) continue;
    byId.set(id, {
      ...artifact, ...byId.get(id), id, path: record.path,
      name: artifactDisplayName(artifact.name || record.name),
      mime: artifact.mime || "application/octet-stream", size: Number(artifact.size),
      createdAt: artifact.createdAt || event.occurredAt,
      ...(record.failure?.message ? { failure: record.failure.message } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

function answerIdentity(value) {
  const identity = parseRemoteArtifactLinks(value).cleaned.split(/\r?\n/)
    .filter((line) => stripFileLinkDecoration(line).trim())
    .join("\n").replace(/\s+/g, " ").trim();
  return identity || (String(value || "").trim() ? "文件已准备好下载。" : "");
}

/** Replay the matching final's original Markdown, including historical runs. */
export function artifactAnswerMarkdown(content, events = []) {
  const identity = answerIdentity(content);
  if (!identity) return String(content || "");
  const candidates = [...events].reverse().filter((event) => ["final", "message"].includes(event.kind));
  for (const event of candidates) {
    const record = eventPayload(event);
    if (event.kind === "message" && (record.delta === true || record.role && record.role !== "assistant")) continue;
    const original = record.artifactMarkdown || record.text;
    if (typeof original !== "string" || !parseRemoteArtifactLinks(original).artifacts.length) continue;
    if (answerIdentity(original) === identity) return original;
  }
  return String(content || "");
}

export function referencedArtifactCards(markdown, ownCards, history, { workspaceId, before } = {}) {
  const needed = new Set(parseRemoteArtifactLinks(markdown).artifacts.map((artifact) => artifact.path));
  for (const card of ownCards) needed.delete(card.path);
  const byPath = new Map();
  if (workspaceId) for (const card of history) {
    if (card.failure || card.workspaceId !== workspaceId || !needed.has(card.path) || !before || card.createdAt > before) continue;
    const previous = byPath.get(card.path);
    if (!previous || previous.createdAt < card.createdAt) byPath.set(card.path, card);
  }
  return [...ownCards, ...byPath.values()];
}
