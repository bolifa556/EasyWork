import { parse, stringify } from "yaml";
import { extractMarkdownFrontmatter } from "../../../../shared/skill-frontmatter.mjs";

function displayValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

export function markdownPreviewParts(content) {
  const source = String(content || "");
  const extracted = extractMarkdownFrontmatter(source);
  if (!extracted) return { body: source, frontmatter: null };
  try {
    const metadata = parse(extracted.yaml, { uniqueKeys: true, maxAliasCount: 0 });
    if (metadata === null || metadata === undefined) return { body: extracted.body, frontmatter: { entries: [], error: "", raw: "" } };
    if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Front matter must be a mapping");
    return {
      body: extracted.body,
      frontmatter: {
        entries: Object.entries(metadata).map(([key, value]) => ({ key, value: displayValue(value) })),
        error: "",
        raw: extracted.yaml,
      },
    };
  } catch {
    // Keep malformed metadata visible without allowing its separators to alter
    // the Markdown heading structure below it.
    return { body: extracted.body, frontmatter: { entries: [], error: "元数据格式有误", raw: extracted.yaml } };
  }
}
