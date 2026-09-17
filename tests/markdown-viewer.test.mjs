import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { markdownPreviewParts } from "../app/easywork/features/viewers/markdown-preview.mjs";

test("Markdown preview separates YAML front matter from the rendered body", () => {
  const source = "---\nname: MiniMax-Music3歌曲生成\ndescription: MiniMax开源音乐生成模型，输入歌词+风格描述生成最长5分钟带人声歌曲。\n---\n\n# 使用方法\n\n输入歌词。";
  const preview = markdownPreviewParts(source);
  assert.deepEqual(preview.frontmatter.entries, [
    { key: "name", value: "MiniMax-Music3歌曲生成" },
    { key: "description", value: "MiniMax开源音乐生成模型，输入歌词+风格描述生成最长5分钟带人声歌曲。" },
  ]);
  assert.match(preview.body, /^\n# 使用方法/);
  assert.doesNotMatch(preview.body, /description:|---/);
});

test("front matter supports BOM, CRLF, lists and multiline values", () => {
  const preview = markdownPreviewParts("\uFEFF\r\n---\r\ntags: [music, voice]\r\ndescription: |-\r\n  第一行\r\n  第二行\r\n---\r\n正文");
  assert.deepEqual(preview.frontmatter.entries, [
    { key: "tags", value: "- music\n- voice" },
    { key: "description", value: "第一行\n第二行" },
  ]);
  assert.equal(preview.body, "正文");
});

test("malformed front matter stays visible but cannot turn following Markdown into a heading", () => {
  const preview = markdownPreviewParts("---\nname: [broken\n---\n# 正文");
  assert.equal(preview.frontmatter.error, "元数据格式有误");
  assert.equal(preview.frontmatter.raw, "name: [broken");
  assert.equal(preview.body, "# 正文");
});

test("ordinary Markdown remains unchanged and viewer renders metadata separately", async () => {
  const source = "# 普通文档\n\n正文\n\n---\n\n结尾";
  assert.deepEqual(markdownPreviewParts(source), { body: source, frontmatter: null });
  const viewer = await readFile(new URL("../app/easywork/features/viewers/MarkdownViewer.tsx", import.meta.url), "utf8");
  assert.match(viewer, /<Frontmatter value=\{preview\.frontmatter\} \/>/);
  assert.match(viewer, />\{preview\.body\}<\/ReactMarkdown>/);
  assert.doesNotMatch(viewer, />\{value\}<\/ReactMarkdown>/);
});
