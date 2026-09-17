// Accept the extra separator dashes and leading blank lines commonly added
// when copying a skill document from Markdown editors.
const FRONTMATTER = /^\uFEFF?(?:[ \t]*\r?\n)*-{3,}[ \t]*\r?\n([\s\S]*?)\r?\n-{3,}[ \t]*(?:\r?\n|$)/;

export function extractMarkdownFrontmatter(content) {
  if (typeof content !== "string") return null;
  const match = FRONTMATTER.exec(content);
  return match ? { yaml: match[1], body: content.slice(match[0].length) } : null;
}

// Kept as a domain-specific alias for existing skill importers.
export const extractSkillFrontmatter = extractMarkdownFrontmatter;
