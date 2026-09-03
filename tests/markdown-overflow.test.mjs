import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesPath = new URL("../app/easywork/features/conversation/MarkdownContent.module.css", import.meta.url);

test("Markdown keeps long code inside its own scroller without widening the conversation", async () => {
  const styles = await readFile(stylesPath, "utf8");

  assert.match(styles, /\.markdown\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
  assert.match(styles, /\.markdown\s*>\s*\*\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
  assert.match(styles, /\.markdown ul,\.markdown ol\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*grid-template-columns:\s*minmax\(0,1fr\);/s);
  assert.match(styles, /\.markdown li\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s);
  assert.match(styles, /\.copyableCodeBlock\s*\{[^}]*display:\s*block;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.markdown > :is\(ul,ol\)\s*\{\s*--code-outdent:1\.6em;\s*\}/s);
  assert.match(styles, /\.markdown > :is\(ul,ol\) :is\(ul,ol\)\s*\{\s*--code-outdent:3\.2em;\s*\}/s);
  assert.match(styles, /\.markdown :is\(ul,ol\) \.copyableCodeBlock\s*\{[^}]*width:\s*calc\(100% \+ var\(--code-outdent\)\);[^}]*max-width:\s*calc\(100% \+ var\(--code-outdent\)\);[^}]*margin-left:\s*calc\(-1 \* var\(--code-outdent\)\);/s);
  assert.match(styles, /\.markdown li \.copyableCodeBlock\s*\{\s*margin-top:\.35em;\s*\}/s);
  assert.match(styles, /\.remoteTerminal\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.remoteTerminal code\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;[^}]*max-width:\s*none;[^}]*white-space:\s*pre;/s);
});
