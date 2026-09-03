import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactDisplayName,
  referencedArtifactsForDownloadReply,
  stripArtifactPlaceholderLines,
} from "../app/easywork/features/conversation/artifact-presentation.mjs";

const artifacts = [
  { id: "artifact-readme", name: "README", createdAt: "2026-08-28T00:00:00.000Z" },
  { id: "artifact-text-old", name: "sample.txt", createdAt: "2026-08-28T00:00:01.000Z" },
  { id: "artifact-text-new", name: "sample.txt", createdAt: "2026-08-28T00:00:02.000Z" },
  { id: "artifact-audio", name: "下载 music3-20260826-141441-60s.wav（60 秒 · 44.1kHz · 立体声 WAV）" },
];

test("下载卡片从旧版冗长标签提取真实文件名", () => {
  assert.equal(artifactDisplayName(artifacts[3].name), "music3-20260826-141441-60s.wav");
  assert.equal(artifactDisplayName("README"), "README");
  assert.equal(artifactDisplayName("sample.tar.gz"), "sample.tar.gz");
});

test("已有卡片时移除正文中的独立文件名占位行", () => {
  const source = "全部文件已准备好，下载链接如下：\n\n- README\n- sample.txt\n\n请点击卡片下载。";
  assert.equal(stripArtifactPlaceholderLines(source, artifacts), "全部文件已准备好，下载链接如下：\n\n请点击卡片下载。");
});

test("已有卡片时折叠远端 Agent 重复输出的下载元数据块", () => {
  const source = "**下载文件卡片**\n\n- 文件名：`sample.txt`\n- 内容：`hello`（已校验）\n- 下载：[sample.txt](file:///tmp/sample.txt)";
  assert.equal(stripArtifactPlaceholderLines(source, artifacts), "");
});

test("旧回复缺少产物关联时仅在明确下载语境复用同对话的最新同名卡片", () => {
  const matched = referencedArtifactsForDownloadReply("sample.txt 的文件已确认存在，下载链接如下：\n\n- sample.txt", artifacts);
  assert.deepEqual(matched.map((entry) => entry.id), ["artifact-text-new"]);
  assert.deepEqual(referencedArtifactsForDownloadReply("项目里使用 sample.txt", artifacts), []);
});
