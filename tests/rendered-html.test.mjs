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
  assert.match(html, /\u6709\u4ec0\u4e48\u53ef\u4ee5\u5e2e\u4f60/);
  assert.doesNotMatch(html, /CHAT · COMPUTE · CREATE|CONVERSATION MAP/);
  assert.doesNotMatch(html, /class="right-rail"/);
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
  assert.match(app, /DEVICE_TOKEN_STORAGE_KEY/);
  assert.match(app, /beginConversation/);
  assert.match(app, /ConversationRow/);
  assert.match(app, /function MarkdownContent/);
  assert.match(app, /\(conversation\.messages\?\.length \?\? 0\) > 0/);
  assert.match(app, /if \(socketRef\.current === socket\)/);
  assert.match(app, /type WorkEventKind/);
  assert.match(app, /\| "approval_request"/);
  assert.match(app, /\| "file_change"/);
  assert.match(app, /\| "job_status"/);
  assert.match(app, /function WorkEventFeed/);
  assert.match(app, /className="trace-jump"/);
  assert.match(app, /className="trace-toggle"/);
  assert.match(app, /event\.status === "running" \|\| expandedCommands\.has/);
  assert.match(app, /转换为\{mode === "chat" \? "工作" : "聊天"\}模式/);
  assert.doesNotMatch(app, /const EMPTY_CONVERSATION_ID/);
  assert.match(app, /Embedding API/);
  assert.match(app, /project-only/);
  assert.match(css, /grid-template-columns:\s*var\(--left-width\).*var\(--right-width\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.trace-detail-motion/);
  assert.match(css, /\.remote-terminal/);
  assert.match(css, /LLMGame-inspired conversation/);
  assert.match(gateway, /keepaliveInterval:\s*15_000/);
  assert.match(gateway, /hostVerifier/);
  assert.match(gateway, /Access-Control-Allow-Private-Network/);
  assert.match(gateway, /\/api\/settings\/provider\/models/);
  assert.match(gateway, /\.easywork\/bin\/opencode/);
  assert.match(gateway, /SSH_RECONNECT_GRACE_MS/);
  assert.match(gateway, /deviceToken/);
  assert.match(gateway, /--no-modify-path/);
  assert.match(gateway, /agentSessions:\s*new Map/);
  assert.match(gateway, /errorPayload\?\.data\?\.message/);
  assert.match(gateway, /readOpenCodeFailureLog/);
  assert.match(gateway, /nextProvider\.protocol = storedProvider\.protocol/);
  assert.match(gateway, /planWorkSteps/);
  assert.match(gateway, /agentPromptWithWorkflow\(context\.text, steps\)/);
  assert.match(gateway, /type: "workflow\.step"/);

  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
  for (const starterAsset of ["file.svg", "globe.svg", "window.svg"]) {
    await assert.rejects(access(new URL(`../public/${starterAsset}`, import.meta.url)));
  }
});

test("keeps machine caches local while persistent EasyWork data remains shareable", async () => {
  const [rules, launcher, viteConfig, gitignore, example] = await Promise.all([
    readFile(new URL("../sync/stignore.shared", import.meta.url), "utf8"),
    readFile(new URL("../frp/start.ps1", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../frp/frpc.example.toml", import.meta.url), "utf8"),
  ]);

  assert.match(rules, /\/EasyWork\/node_modules/);
  assert.match(rules, /\/EasyWork\/\.cache/);
  assert.match(rules, /\/EasyWork\/frp\/frpc\.local\.toml/);
  assert.doesNotMatch(rules, /^\(\?d\)\/EasyWork\/data/m);
  assert.doesNotMatch(rules, /^\(\?d\)\/EasyWork\/skill/m);
  assert.match(launcher, /EasyWork 网关/);
  assert.match(launcher, /EasyWork 网页/);
  assert.match(launcher, /Initialize-LocalFrpConfig/);
  assert.match(launcher, /\.cache\\devices\\/);
  assert.match(viteConfig, /proxy:/);
  assert.match(viteConfig, /"\/ws"/);
  assert.match(gitignore, /\/frp\/frpc\.local\.toml/);
  assert.match(example, /REPLACE_WITH_FRP_TOKEN/);
  assert.doesNotMatch(example, /auth\.token\s*=\s*"[a-f0-9]{32,}"/i);
});
