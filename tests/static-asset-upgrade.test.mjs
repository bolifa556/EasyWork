import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveClientAssets, builtAssetHandler } from "../scripts/static-assets.mjs";

test("old lazy chunks and their dependencies remain available after replacing a build", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "client");
  const archive = path.join(root, "shared-client");
  await fs.mkdir(path.join(source, "assets"), { recursive: true });
  await fs.writeFile(path.join(source, "assets", "Workbench-old.js"), 'import "./terminal-old.js";');
  await fs.writeFile(path.join(source, "assets", "terminal-old.js"), 'export default "terminal";');
  await fs.writeFile(path.join(source, "assets", "Workbench-old.css"), '.workbench { color: green }');
  await archiveClientAssets(source, archive);
  await fs.rm(source, { recursive: true });
  await fs.mkdir(path.join(source, "assets"), { recursive: true });
  await fs.writeFile(path.join(source, "assets", "Workbench-new.js"), 'export default "new";');
  await archiveClientAssets(source, archive);
  const handler = builtAssetHandler(archive);
  const server = http.createServer((request, response) => { void handler(request, response).then((served) => { if (!served) { response.writeHead(404); response.end(); } }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [name, type] of [["Workbench-old.js", "javascript"], ["terminal-old.js", "javascript"], ["Workbench-old.css", "css"], ["Workbench-new.js", "javascript"]]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/assets/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), new RegExp(type));
    assert.equal(await response.text(), await fs.readFile(path.join(archive, "assets", name), "utf8"));
  }
});
