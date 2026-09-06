import { parse } from "yaml";
import { extractSkillFrontmatter } from "../../../../shared/skill-frontmatter.mjs";

const FIELD_LIMITS = Object.freeze({ name: 256, description: 8192 });

function normalizedField(field, value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= FIELD_LIMITS[field] ? normalized : null;
}

export function parseSkillFrontmatter(content) {
  const frontmatter = extractSkillFrontmatter(content);
  if (!frontmatter) return {};
  try {
    const metadata = parse(frontmatter.yaml, { uniqueKeys: true, maxAliasCount: 0 });
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    return Object.fromEntries(Object.keys(FIELD_LIMITS)
      .map((field) => [field, normalizedField(field, metadata[field])])
      .filter(([, value]) => value));
  } catch { return {}; }
}

export function readSkillMetadata(files) {
  if (!Array.isArray(files)) return {};
  const skillFile = files.find((file) => /^SKILL\.md$/i.test(file?.path))
    || files.find((file) => /(?:^|\/)SKILL\.md$/i.test(file?.path));
  if (skillFile) return parseSkillFrontmatter(skillFile.content);
  const candidates = files
    .filter((file) => /\.(?:md|mdx)$/i.test(file?.path))
    .map((file) => ({ path: file.path, metadata: parseSkillFrontmatter(file.content) }))
    .filter(({ metadata }) => metadata.name || metadata.description);
  const rootCandidates = candidates.filter((file) => !file.path.includes("/"));
  const matches = rootCandidates.length ? rootCandidates : candidates;
  // Several distinct skill documents are ambiguous; never mix their fields.
  return matches.length === 1 ? matches[0].metadata : {};
}
export function splitServerRules(value) {
  return [...new Set(String(value).split(/[,，;；\r\n]/).map((entry) => entry.trim()).filter(Boolean))];
}
