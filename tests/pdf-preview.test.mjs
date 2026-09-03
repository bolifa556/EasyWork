import assert from "node:assert/strict";
import test from "node:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

function descriptorlessChinesePdf(text) {
  const encoded = Array.from(text, (character) => character.codePointAt(0).toString(16).padStart(4, "0")).join("").toUpperCase();
  const stream = `BT /F1 24 Tf 72 760 Td <${encoded}> Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>",
  ];
  let source = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "latin1"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "latin1");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(source, "latin1"));
}

test("PDF preview recovers descriptor-less Chinese CID fonts", async () => {
  const expected = "中国科大大模型公共服务平台欢迎您！";
  const document = await getDocument({
    data: descriptorlessChinesePdf(expected),
    cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
    cMapPacked: true,
    useSystemFonts: false,
  }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    assert.equal(content.items.map((item) => item.str).join(""), expected);

    const operations = await page.getOperatorList();
    const showTextIndex = operations.fnArray.indexOf(OPS.showText);
    assert.notEqual(showTextIndex, -1);
    const glyphs = operations.argsArray[showTextIndex][0];
    assert.equal(glyphs.map((glyph) => glyph.fontChar).join(""), expected);
    assert.deepEqual([...new Set(glyphs.map((glyph) => glyph.width))], [1000]);
  } finally {
    await document.destroy();
  }
});
