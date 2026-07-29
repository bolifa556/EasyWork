import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished EasyWork shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>EasyWork — 对话连接算力<\/title>/);
  assert.match(html, /EasyWork/);
  assert.match(html, /CHAT · COMPUTE · CREATE/);
  assert.match(html, /CONVERSATION MAP/);
  assert.match(html, /\u65b0\u804a\u5929/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/i);
});

test("includes the two-mode product architecture and removes starter artifacts", async () => {
  const [app, css, gateway, prompts, builtIns] = await Promise.all([
    readFile(new URL("../app/EasyWorkApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../gateway/server.mjs", import.meta.url), "utf8"),
    readdir(new URL("../prompts/", import.meta.url)),
    readdir(new URL("../skill/built-in/", import.meta.url)),
  ]);

  assert.deepEqual(prompts.sort(), ["chat-system.md", "work-system.md"]);
  assert.deepEqual(builtIns.sort(), ["cluster-ops", "paper-reading", "training-debug"]);
  assert.match(app, /type Mode = "chat" \| "work"/);
  assert.match(app, /type: "work\.run"/);
  assert.match(app, /\/api\/bootstrap/);
  assert.match(app, /Embedding API/);
  assert.match(app, /project-only/);
  assert.match(css, /grid-template-columns:\s*var\(--left-width\).*var\(--right-width\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(gateway, /keepaliveInterval:\s*15_000/);
  assert.match(gateway, /hostVerifier/);
  assert.match(gateway, /\.easywork\/bin\/opencode/);
  assert.match(gateway, /agentSessions:\s*new Map/);

  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
  for (const starterAsset of ["file.svg", "globe.svg", "window.svg"]) {
    await assert.rejects(access(new URL(`../public/${starterAsset}`, import.meta.url)));
  }
});

