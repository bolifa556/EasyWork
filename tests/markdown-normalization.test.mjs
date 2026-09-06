import assert from "node:assert/strict";
import test from "node:test";

import { ensureBlankLineBeforeTables, ensureSectionBlockBoundaries, protectShellVariablesFromInlineMath } from "../app/easywork/features/conversation/markdown-normalization.mjs";

test("shell environment variables cannot consume later prose as inline math", () => {
  const source = "Run srun echo $SLURM_ARRAY_TASK_ID, then inspect $SLURM_JOB_ID and ${SLURM_ARRAY_JOB_ID}_${SLURM_ARRAY_TASK_ID}.";
  assert.equal(
    protectShellVariablesFromInlineMath(source),
    "Run srun echo \\$SLURM_ARRAY_TASK_ID, then inspect \\$SLURM_JOB_ID and \\${SLURM_ARRAY_JOB_ID}_\\${SLURM_ARRAY_TASK_ID}.",
  );
});

test("math and Markdown code remain untouched while existing escapes stay idempotent", () => {
  const source = [
    "Inline $x_i + y_i$ and display $$E=mc^2$$.",
    "Already escaped \\$SLURM_JOB_ID.",
    "Use `$SLURM_ARRAY_TASK_ID` inline.",
    "```bash",
    "echo $SLURM_ARRAY_TASK_ID ${SLURM_JOB_ID}",
    "```",
  ].join("\n");
  assert.equal(protectShellVariablesFromInlineMath(source), source);
});

test("a dollar-delimited uppercase math identifier remains math", () => {
  assert.equal(protectShellVariablesFromInlineMath("The value is $HOME$ in this formula."), "The value is $HOME$ in this formula.");
});

test("a GFM table directly after a label receives a block boundary", () => {
  const source = [
    "**边界换算结果**(`parse_duration(...)`)",
    "| 字段 | 原值 | 结果 |",
    "| --- | --- | --- |",
    "| Elapsed | `00:00:01` | 1 s |",
  ].join("\n");
  assert.equal(
    ensureBlankLineBeforeTables(source),
    source.replace("\n| 字段", "\n\n| 字段"),
  );
});

test("table normalization is idempotent and ignores fenced examples", () => {
  const separated = "说明\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(ensureBlankLineBeforeTables(separated), separated);
  const fenced = "说明\n```md\n| A | B |\n| --- | --- |\n```";
  assert.equal(ensureBlankLineBeforeTables(fenced), fenced);
});

test("standalone section labels do not become lazy continuations of Agent lists", () => {
  const source = [
    "你好！我是 Codex。",
    "**我能做什么**",
    "- 读写代码",
    "- 做多步任务",
    "**我的风格**",
    "- 改动克制精准",
    "- 先验证再回答",
    "当前工作目录为空。",
  ].join("\n");
  const expected = [
    "你好！我是 Codex。",
    "",
    "**我能做什么**",
    "",
    "- 读写代码",
    "- 做多步任务",
    "",
    "**我的风格**",
    "",
    "- 改动克制精准",
    "- 先验证再回答",
    "",
    "当前工作目录为空。",
  ].join("\n");
  assert.equal(ensureSectionBlockBoundaries(source), expected);
  assert.equal(ensureSectionBlockBoundaries(expected), expected);
});

test("section boundary repair leaves fenced and indented Markdown untouched", () => {
  const source = [
    "```md",
    "**示例标题**",
    "- 示例列表",
    "```",
    "",
    "**说明**",
    "",
    "- 第一项",
    "  延续说明",
  ].join("\n");
  assert.equal(ensureSectionBlockBoundaries(source), source);
});
