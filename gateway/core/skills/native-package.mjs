import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import { invariant } from "../errors.mjs";
import { extractSkillFrontmatter } from "../../../shared/skill-frontmatter.mjs";

export function nativeSkillName(skillId) {
  const slug = String(skillId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${slug.slice(0, 48) || "skill"}-${crypto.createHash("sha256").update(String(skillId)).digest("hex").slice(0, 8)}`;
}

export function parseNativeSkill(content) {
  const source = Buffer.isBuffer(content) ? content.toString("utf8") : String(content || "");
  const frontmatter = extractSkillFrontmatter(source);
  if (!frontmatter) return { metadata: {}, body: source };
  let metadata;
  try { metadata = parse(frontmatter.yaml, { uniqueKeys: true, maxAliasCount: 0 }); }
  catch { invariant(false, "SKILL_METADATA_INVALID", "SKILL.md 的 YAML 元数据无效", { status: 400 }); }
  invariant(metadata && typeof metadata === "object" && !Array.isArray(metadata), "SKILL_METADATA_INVALID", "SKILL.md 元数据必须是对象", { status: 400 });
  return { metadata, body: frontmatter.body };
}

export function normalizeNativeSkillFiles({ skillId, name, description, entrypoint, files }) {
  const entry = files.find((file) => file.path === "SKILL.md") || files.find((file) => file.path === entrypoint);
  invariant(entry, "SKILL_ENTRYPOINT_MISSING", "技能包没有入口文件", { status: 400 });
  const markdown = /\.(?:md|mdx|txt)$/i.test(entry.path);
  const parsed = markdown ? parseNativeSkill(entry.content) : { metadata: {}, body: `# ${name}\n\n${description}\n\n技能入口：[${entry.path}](${entry.path})。先读取该入口，按用户要求使用。\n` };
  const declaredName = String(parsed.metadata.name || "");
  const nativeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(declaredName) && declaredName.length <= 64 ? declaredName : nativeSkillName(skillId);
  invariant(nativeName !== "easywork-selected", "SKILL_NAME_RESERVED", "该技能名称由运行器保留", { status: 400 });
  const nativeDescription = String(parsed.metadata.description || description || name || "").trim();
  invariant(nativeDescription && nativeDescription.length <= 8192, "SKILL_DESCRIPTION_REQUIRED", "技能需要可供原生 Agent 发现的说明", { status: 400 });
  const base = markdown && path.posix.dirname(entry.path) !== "." ? `\n原始技能入口位于 ${entry.path}；其中的相对资源路径相对于 ${path.posix.dirname(entry.path)}。\n` : "";
  const content = Buffer.from(`---\n${stringify({ ...parsed.metadata, name: nativeName, description: nativeDescription }).trimEnd()}\n---\n\n${base}${parsed.body.trim()}\n`);
  return [...files.filter((file) => file.path.toLowerCase() !== "skill.md"), { path: "SKILL.md", content }].sort((a, b) => a.path.localeCompare(b.path));
}

// Older installations saved the generated Agent entry beside the user's source.
// Restore that source only when the extra file matches the generated document or
// its machine-derived identity and metadata. Keep independently authored files.
export function restoreOriginalSkillFiles({ skillId, entrypoint, files, ...manifest }) {
  const source = files.find((file) => file.path === entrypoint);
  const native = files.find((file) => file.path === "SKILL.md");
  if (!source || !native || source === native) return files;
  try {
    const originals = files.filter((file) => file !== native);
    const expected = normalizeNativeSkillFiles({ skillId, entrypoint, ...manifest, files: originals }).find((file) => file.path === "SKILL.md");
    const text = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    const normalized = (value) => text(value).replace(/\r\n/g, "\n");
    if (normalized(expected.content) === normalized(native.content)) return originals;
    if (!/\.(?:md|mdx|txt)$/i.test(entrypoint)) return files;
    const generated = parseNativeSkill(expected.content);
    const edited = parseNativeSkill(native.content);
    if (edited.metadata.name !== nativeSkillName(skillId) || !isDeepStrictEqual(edited.metadata, generated.metadata)) return files;
    if (normalized(edited.body).trim() === normalized(generated.body).trim()) return originals;
    const originalText = text(source.content);
    const frontmatter = extractSkillFrontmatter(originalText);
    const header = frontmatter ? originalText.slice(0, originalText.length - frontmatter.body.length) : "";
    const base = path.posix.dirname(entrypoint) === "." ? "" : `原始技能入口位于 ${entrypoint}；其中的相对资源路径相对于 ${path.posix.dirname(entrypoint)}。`;
    let body = normalized(edited.body).trim();
    if (base && body.startsWith(base)) body = body.slice(base.length).trimStart();
    const newline = originalText.includes("\r\n") ? "\r\n" : "\n";
    const content = Buffer.from(header + (header ? newline : "") + body.replace(/\n/g, newline) + newline);
    return originals.map((file) => file === source ? { path: file.path, content } : file);
  } catch { return files; }
}
