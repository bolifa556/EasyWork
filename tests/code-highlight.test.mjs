import assert from "node:assert/strict";
import test from "node:test";
import { highlightCode } from "../app/easywork/features/conversation/code-highlight.ts";

function text(node) { return node.type === "text" ? node.value : node.children.map(text).join(""); }
function tokens(node) { return [node, ...(node.children || []).flatMap(tokens)].filter((entry) => entry.type === "element"); }

test("命令、连字符参数和路径有高亮，换行、中文和原始代码逐字保留", () => {
  const source = 'envs/mpnn/bin/python scripts/score_designs.py --complex-dir ... --seq-dir ... \\\n  --trb-dir ... --ligname FK5 --out outputs/<批次>/summary.tsv\nDESIGN=<批次> TOPN=4 PER=1 CLEAN=1 sbatch scripts/40_boltz_validate.sbatch\n';
  for (const language of ["bash", "sh", "shell", "console", "terminal"]) {
    const root = highlightCode(source, language);
    assert.equal(text(root), source);
    for (const [value, kind] of [["envs/mpnn/bin/python", "function"], ["--complex-dir", "variable"], ["scripts/score_designs.py", "string"], ["sbatch", "function"]]) {
      assert.ok(tokens(root).some((node) => text(node) === value && node.properties.className.includes(kind)), language + ": " + value);
    }
  }
});

test("常用语言和未完成的流式代码保留全部源文本，只产生文字与 span", () => {
  const examples = {
    python: 'def greet(name):\n    # 中文\n    print("你好", name)\n',
    json: '{"key": "<script>alert(1)</script>", "ready": true, "n": 4}',
    js: 'const node = "<img src=x onerror=alert(1)>";\n',
    tsx: 'const view = <button onClick={() => send()}>保存</button>;',
    yaml: 'name: example\ncount: 12\n',
    sql: "SELECT name FROM files WHERE id = 1;",
    css: '.card { color: #333; }',
    html: '<script>alert("example")</script>',
    pwsh: '$name = "测试"\nWrite-Output $name',
  };
  for (const [language, source] of Object.entries(examples)) {
    for (const value of [source, source.slice(0, Math.ceil(source.length / 2))]) {
      const root = highlightCode(value, language);
      assert.equal(text(root), value);
      assert.ok(tokens(root).every((node) => node.tagName === "span" && Object.keys(node.properties).every((key) => key === "className")));
    }
  }
});

test("未知语言和大日志回退为普通代码文本", () => {
  assert.equal(highlightCode("hello", "unknown-language"), null);
  assert.equal(highlightCode("echo hello", ""), null);
  assert.equal(highlightCode("x".repeat(64_001), "bash"), null);
  assert.equal(highlightCode("", "bash"), null);
});
