const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FIELD_LIMITS = Object.freeze({ name: 256, description: 8192 });

function parseQuotedScalar(value) {
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return null;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : null;
  if (/^[\[\]{}&*!%@`]/.test(value) || /:\s/.test(value)) return null;
  return value.replace(/[ \t]+#.*$/, "").trim();
}

function normalizedField(field, value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= FIELD_LIMITS[field] ? normalized : null;
}

export function parseSkillFrontmatter(content) {
  if (typeof content !== "string") return {};
  const match = FRONTMATTER.exec(content);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};
  for (let index = 0; index < lines.length; index += 1) {
    const fieldMatch = /^(name|description)[ \t]*:[ \t]*(.*)$/.exec(lines[index]);
    if (!fieldMatch) continue;
    const field = fieldMatch[1];
    let raw = fieldMatch[2].trim();
    if (/^[>|][+-]?$/.test(raw)) {
      const folded = raw.startsWith(">");
      const chunks = [];
      while (index + 1 < lines.length && /^(?:[ \t]+|$)/.test(lines[index + 1])) {
        index += 1;
        chunks.push(lines[index].replace(/^[ \t]+/, ""));
      }
      raw = folded ? chunks.join(" ") : chunks.join("\n");
    }
    const value = normalizedField(field, parseQuotedScalar(raw));
    if (value) result[field] = value;
  }
  return result;
}

export function readSkillMetadata(files) {
  if (!Array.isArray(files)) return {};
  const skillFile = files.find((file) => /^SKILL\.md$/i.test(file?.path))
    || files.find((file) => /(?:^|\/)SKILL\.md$/i.test(file?.path));
  return skillFile ? parseSkillFrontmatter(skillFile.content) : {};
}
export function splitServerRules(value) {
  return [...new Set(String(value).split(/[,，;；\r\n]/).map((entry) => entry.trim()).filter(Boolean))];
}
