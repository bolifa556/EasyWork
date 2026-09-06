import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { SshRemoteArtifactSource } from "../gateway/core/runtime/remote.mjs";
import { emitLinkedRemoteArtifacts } from "../gateway/core/agents/common.mjs";
import { parseRemoteArtifactLinks } from "../shared/remote-artifact-links.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("timeline final identity matches extracted cards without hiding different intermediate text", () => {
  const normalize = (value) => parseRemoteArtifactLinks(value).cleaned.replace(/\s+/g, " ").trim();
  const examples = [
    "清单已写好，点击下载：[买菜清单](file:///work/list.md) 包含蔬菜和水果。",
    "文件已确认存在。\n\n📄 [周末安排](file:///work/weekend.md)\n\n这是刚才创建的文档。",
    "[括号](file:///work/a(b).txt)",
    "正文。\n\n[引用][file]\n\n[file]: file:///work/report.txt",
  ];
  for (const original of examples) {
    const cleaned = emitLinkedRemoteArtifacts({ state: { items: {} }, emit() {} }, original);
    assert.equal(normalize(original), normalize(cleaned));
    assert.notEqual(normalize("正在准备，请稍候。"), normalize(cleaned));
  }
  assert.notEqual(normalize("`[示例](file:///work/example.txt)`"), normalize("文件已准备好下载。"));
});
test("Markdown AST extracts balanced, encoded, multiline and reference file links without touching code", () => {
  const events = [];
  const context = { state: { items: {} }, emit: (...event) => events.push(event) };
  const original = "正文\n\n- [报告](file:///work/report(final).txt)\n- [中文](file:///work/%E4%B8%AD%E6%96%87%20a.txt)\n- [跨行\n链接](file:///work/multi.txt)\n\n保留这个段落。\n\n[引用][report] 和 [再次引用][report]\n\n[report]: file:///work/reference.txt\n\n`[示例](file:///work/code.txt)`\n\n```md\n[代码](file:///work/fenced.txt)\n```";
  const cleaned = emitLinkedRemoteArtifacts(context, original);
  assert.deepEqual(events.map((entry) => entry[2].path), ["/work/report(final).txt", "/work/中文 a.txt", "/work/multi.txt", "/work/reference.txt"]);
  assert.match(cleaned, /\n\n保留这个段落。\n\n/);
  assert.match(cleaned, /`\[示例\]\(file:\/\/\/work\/code.txt\)`/);
  assert.match(cleaned, /\[代码\]\(file:\/\/\/work\/fenced.txt\)/);
  assert.doesNotMatch(cleaned, /report\(final\)|reference.txt|multi.txt|中文%20/);
  assert.equal(context.state.items["easywork:linked-final"].original, original);
});

function fixture() {
  const file = "/work/test.txt", bytes = Buffer.from("1234567890");
  const files = new Map([[file, bytes]]);
  const opens = [];
  const executor = {
    mutateOnOpen: false, mutateOnCopy: false, failOpen: false,
    async home() { return "/home/audit"; },
    async exec(command) {
      const copy = command.match(/cp --reflink=auto -- '([^']+)' '([^']+)'/);
      const remove = command.match(/^rm -f -- '([^']+)'/);
      if (remove) { files.delete(remove[1]); return { code: 0, stdout: "" }; }
      let target = file;
      if (copy) {
        if (this.mutateOnCopy) files.set(file, Buffer.from("ABCDEFGHIJ"));
        files.set(copy[2], Buffer.from(files.get(copy[1]))); target = copy[2];
      }
      const content = files.get(target);
      return { code: content ? 0 : 44, stdout: content ? `${content.length}\n${digest(content)}\n` : "" };
    },
    openReadStream(target, range) {
      if (this.failOpen) throw new Error("SFTP open failure");
      if (this.mutateOnOpen) files.set(file, Buffer.from("ABCDEFGHIJ"));
      opens.push(target);
      return Readable.from([files.get(target).subarray(range.start, range.end + 1)]);
    },
  };
  const source = new SshRemoteArtifactSource({ executor, container: { actor: { actorId: "audit" } }, serverId: "server", serverIdentity: "ssh-audit" });
  const input = { canonicalPath: file, expectedSize: bytes.length, expectedSha256: digest(bytes), range: { start: 0, endExclusive: bytes.length } };
  return { source, input, files, executor, opens, file, bytes };
}
async function read(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
test("artifact full and range streams use a verified private snapshot and release it after download", async () => {
  for (const range of [{ start: 0, endExclusive: 10 }, { start: 2, endExclusive: 7 }]) {
    const f = fixture(); f.executor.mutateOnOpen = true;
    const bytes = await read(await f.source.openReadStream({ ...f.input, range }));
    assert.deepEqual(bytes, f.bytes.subarray(range.start, range.endExclusive));
    assert.notEqual(f.opens[0], f.file);
    await tick();
    assert.deepEqual([...f.files.keys()], [f.file]);
  }
});
test("same-size mutation before or during snapshot creation fails closed without leaving a copy", async () => {
  const f = fixture(); f.files.set(f.file, Buffer.from("ABCDEFGHIJ"));
  await assert.rejects(() => f.source.verifyAvailable(f.input), { code: "ARTIFACT_REMOTE_CHANGED" });
  const g = fixture(); g.executor.mutateOnCopy = true;
  await assert.rejects(() => g.source.openReadStream(g.input), { code: "ARTIFACT_REMOTE_CHANGED" });
  assert.deepEqual([...g.files.keys()], [g.file]);
  assert.equal(g.opens.length, 0);
});
test("synchronous SFTP open failure releases the verified artifact snapshot", async () => {
  const f = fixture(); f.executor.failOpen = true;
  await assert.rejects(() => f.source.openReadStream(f.input), /SFTP open failure/);
  await tick();
  assert.deepEqual([...f.files.keys()], [f.file]);
});
