import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillFrontmatter, readSkillMetadata } from "../app/easywork/features/skills/skill-metadata.mjs";
import { normalizeNativeSkillFiles, parseNativeSkill, restoreOriginalSkillFiles } from "../gateway/core/skills/native-package.mjs";

const metadata = { name: "涉及算力平台的应用skill格式规范", description: "用户提到创建应用 skill 时，生成包含应用用途、路径、环境和输入输出的技能。" };
const document = `---\nname: ${metadata.name}\ndescription: ${metadata.description}\n---\n\n# 技能内容`;
const file = (path, content = document) => ({ path, content });

test("自定义 Markdown 文件名、大小写和嵌套路径都能识别技能名称与简介", () => {
  for (const name of ["create_easyworkSkill.md", "应用技能创建规范.MD", "folder/app-guide.mdx"]) {
    assert.deepEqual(readSkillMetadata([file(name)]), metadata);
  }
});

test("技能主文件优先，根目录自定义文档优先于参考附件", () => {
  const reference = file("references/other.md", document.replace(metadata.name, "其他技能"));
  assert.deepEqual(readSkillMetadata([reference, file("create_easyworkSkill.md")]), metadata);
  assert.deepEqual(readSkillMetadata([reference, file("nested/SKILL.md")]), metadata);
  assert.deepEqual(readSkillMetadata([file("nested/SKILL.md", reference.content), file("SKILL.md")]), metadata);
  assert.deepEqual(readSkillMetadata([file("SKILL.md", "# 没有元数据"), reference]), {});
});

test("多份自定义技能文档存在歧义时不拼接或任意覆盖字段", () => {
  assert.deepEqual(readSkillMetadata([file("one.md"), file("two.md", document.replace(metadata.name, "另一个技能"))]), {});
  assert.deepEqual(readSkillMetadata([file("script.py"), file("notes.md", "普通附件正文")]), {});
});

test("元数据支持 BOM、Windows 换行、空行和长横线分隔符，前后端识别一致", () => {
  const source = "\uFEFF\r\n \r\n" + document.replace(/\n/g, "\r\n").replace(/---\r\n\r\n#/, "-".repeat(80) + "\r\n\r\n#");
  assert.deepEqual(readSkillMetadata([file("create_easyworkSkill.md", source)]), metadata);
  assert.deepEqual(parseNativeSkill(source), { metadata, body: "\r\n# 技能内容" });
  const files = normalizeNativeSkillFiles({ skillId: "skill-authoring", ...metadata, entrypoint: "create_easyworkSkill.md", files: [file("create_easyworkSkill.md", source)] });
  const native = parseNativeSkill(files.find((entry) => entry.path === "SKILL.md").content);
  assert.equal(native.metadata.description, metadata.description);
  assert.equal(native.body.trim(), "# 技能内容");
});

test("YAML 多行简介中的冒号、引号和注释得到正确解析", () => {
  assert.deepEqual(parseSkillFrontmatter(`---\nname: '应用技能' # 显示名称\ndescription: >-\n  输入: CSV 数据。\n  输出: JSON 结果。\n---\n`), { name: "应用技能", description: "输入: CSV 数据。 输出: JSON 结果。" });
  assert.deepEqual(parseSkillFrontmatter(`---\nname: "应用技能"\ndescription: |\n  第一行 # 保留正文\n  第二行\n---\n`), { name: "应用技能", description: "第一行 # 保留正文\n第二行" });
});

test("非法 YAML、重复键和正文中的技能模板不误填表单", () => {
  for (const content of ["---\nname: [broken\n---", "---\nname: one\nname: two\n---", "# 技能说明\n\n```md\n" + document + "\n```", "---\n- name: list\n---"]) {
    assert.deepEqual(parseSkillFrontmatter(content), {});
  }
});

test("旧生成入口清理保留嵌套资源路径、最新正文和真实的多文件技能", () => {
  const entrypoint = "app/guide.md";
  const input = { skillId: "legacy-nested", ...metadata, entrypoint };
  const original = [file(entrypoint, document + "\n\n[运行脚本](scripts/run.py)"), file("app/scripts/run.py", "print('run')")];
  const legacy = normalizeNativeSkillFiles({ ...input, files: original });
  assert.deepEqual(restoreOriginalSkillFiles({ ...input, files: legacy }), original);
  const edited = legacy.map((entry) => entry.path === "SKILL.md" ? { ...entry, content: Buffer.from(entry.content.toString().replace("# 技能内容", "# 更新后的技能内容")) } : entry);
  const restored = restoreOriginalSkillFiles({ ...input, files: edited });
  assert.deepEqual(restored.map((entry) => entry.path), original.map((entry) => entry.path));
  assert.match(restored[0].content.toString(), /# 更新后的技能内容/);
  assert.match(restored[0].content.toString(), /\[运行脚本\]\(scripts\/run.py\)/);
  assert.doesNotMatch(restored[0].content.toString(), /原始技能入口位于/);
  const authored = [...original, file("SKILL.md", "---\nname: independently-authored\ndescription: A separate entry\n---\n# 独立内容")];
  assert.equal(restoreOriginalSkillFiles({ ...input, files: authored }), authored);
});
