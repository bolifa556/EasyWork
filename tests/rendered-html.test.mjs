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

test("server-renders the EasyWork shell with an in-workspace loading state", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>EasyWork — 对话连接算力<\/title>/);
  assert.match(html, /EasyWork/);
  assert.match(html, /class="workspace-loading-indicator"/);
  assert.match(html, /正在加载/);
  assert.doesNotMatch(html, /class="unified-composer/);
  assert.match(html, /\u65b0\u804a\u5929/);
  assert.doesNotMatch(html, /CHAT · COMPUTE · CREATE|CONVERSATION MAP/);
  assert.doesNotMatch(html, /class="right-rail"/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/i);
});

test("includes the two-mode product architecture and removes starter artifacts", async () => {
  const [app, css, layout, gateway, prompts, builtIns, help] = await Promise.all([
    readFile(new URL("../app/EasyWorkApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../gateway/server.mjs", import.meta.url), "utf8"),
    readdir(new URL("../prompts/", import.meta.url)),
    readdir(new URL("../skill/built-in/", import.meta.url)),
    readFile(new URL("../help/help.md", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(prompts.sort(), [
    "README.md",
    "agents",
    "chat-system.md",
    "context",
    "memory",
    "model",
    "tasks",
    "web",
    "work-system.md",
  ]);
  assert.deepEqual(builtIns.sort(), ["cluster-ops", "paper-reading", "training-debug"]);
  assert.match(app, /type Mode = "chat" \| "work"/);
  assert.match(app, /type: "work\.run"/);
  assert.match(app, /\/api\/bootstrap/);
  assert.match(app, /DEVICE_TOKEN_STORAGE_KEY/);
  assert.match(app, /beginConversation/);
  assert.match(app, /\/api\/conversations\/action/);
  assert.match(app, /actOnConversationMessage\(\s*"edit"/);
  assert.match(app, /actOnConversationMessage\(\s*"rewind"/);
  assert.match(app, /回溯会保留这条回复/);
  assert.doesNotMatch(app, /\/api\/conversations\/branch/);
  assert.doesNotMatch(app, /branchConversationFromMessage/);
  assert.match(app, /function UnifiedComposer/);
  assert.match(app, /const isNewConversation = activeMessageCount === 0/);
  assert.match(app, /new-conversation-mode-switch/);
  assert.match(app, /className="new-work-setup"/);
  assert.match(app, /请先设置工作区/);
  assert.match(app, /setDraftWorkspace\(workspace\)/);
  assert.doesNotMatch(app, /访客数据保存在临时目录/);
  assert.doesNotMatch(app, /onDeleteGuest/);
  assert.match(app, /key=\{actor\.id\}/);
  assert.match(app, /if \(bootstrap\.actor\) onActor\(bootstrap\.actor\)/);
  assert.match(app, /account-modal-authenticated/);
  assert.match(app, /type ViewName = "chat" \| "project" \| "library" \| "skills" \| "help"/);
  assert.match(app, /<span>帮助<\/span>/);
  assert.match(app, /gatewayFetch\("\/api\/help"/);
  assert.match(app, /new EventSource\(/);
  assert.match(app, /addEventListener\("help\.changed", refreshChangedHelp\)/);
  assert.doesNotMatch(app, /1_500/);
  assert.match(app, /<MarkdownContent content=\{helpContent\} help \/>/);
  assert.doesNotMatch(app, /help\.md\?raw/);
  assert.doesNotMatch(app, /view === "memory"/);
  assert.doesNotMatch(app, /<span>记忆<\/span>/);
  assert.doesNotMatch(app, /<span>邮箱<\/span>/);
  assert.match(app, /\/邮箱\/\.test\(responseMessage\)/);
  assert.match(app, /"用户名或密码不正确"/);
  assert.match(app, /body: JSON\.stringify\(\{ username, password \}\)/);
  assert.match(
    app,
    /new-work-setup-value server-ready[\s\S]*配置 Agent[\s\S]*设置工作区/,
  );
  assert.match(
    app,
    /\{isNewConversation && \(\s*<p>EasyWork 可能会出错，请核对重要信息。<\/p>/,
  );
  const beginConversationSource = app.match(
    /const beginConversation =[\s\S]*?const openProject =/,
  )?.[0] ?? "";
  assert.doesNotMatch(beginConversationSource, /setDraftServerId\(""\)/);
  assert.doesNotMatch(beginConversationSource, /setDraftWorkspace\(null\)/);
  assert.match(help, /# EasyWork 使用帮助/);
  assert.match(help, /登录/);
  assert.match(help, /配置模型 API/);
  assert.match(help, /聊天模式/);
  assert.match(help, /工作模式/);
  assert.match(help, /连接服务器/);
  assert.match(help, /配置 Agent/);
  assert.match(help, /选择工作区/);
  assert.match(gateway, /function normalizeUsername/);
  assert.match(gateway, /url\.pathname === "\/api\/help\/events"/);
  assert.match(gateway, /event: help\.changed/);
  assert.doesNotMatch(gateway, /function normalizeEmail/);
  assert.doesNotMatch(app, /mode === "chat" && <p>EasyWork 可能会出错/);
  assert.match(app, /useLayoutEffect/);
  assert.match(app, /maximumHeight = expanded \? Math\.max\(300/);
  assert.match(app, /multiline \? " multiline"/);
  assert.match(app, /expanded \? " expanded"/);
  assert.match(app, /function WebContextRing/);
  assert.match(app, /function ScrollingPath/);
  assert.match(app, /workspace-path-viewport/);
  assert.match(app, /project-composer-area/);
  assert.match(app, /project-launch-mode/);
  assert.match(app, /function WorkspacePickerModal/);
  assert.match(app, /workspace-rail-panel/);
  assert.match(app, /workspace-kind-selector/);
  assert.doesNotMatch(app, /workspace-picker-button/);
  assert.match(app, /conversation-mode-stack/);
  assert.doesNotMatch(app, /function WebContextMeter/);
  assert.doesNotMatch(app, /className="context-meter-row web"/);
  assert.match(app, /className={`web-context-ring/);
  assert.match(app, /管理网页对话上下文配置/);
  assert.match(app, /providers: ModelProvider\[\]/);
  assert.match(app, /className="provider-manager"/);
  assert.match(app, /className="provider-tabs"/);
  assert.match(app, /agent-model-option-copy/);
  assert.match(app, /function AgentContextRing/);
  assert.match(app, /function AgentContextControls/);
  assert.match(app, /className={`agent-context-ring/);
  assert.match(app, /该 Agent 不支持修改上下文限制/);
  assert.match(app, /function ContextDetailModal/);
  assert.match(app, /title="网页对话上下文"/);
  assert.match(app, /className="work-connection-copy"/);
  assert.match(app, /className="work-connection-status-line"/);
  assert.doesNotMatch(
    app,
    /connection\.host \|\|\s*activeServerProfile\?\.host \|\|\s*"连接服务器"/,
  );
  assert.match(app, /切换后会使用该工作区对应的 Agent 会话/);
  assert.match(app, /workspaceId: executionWorkspace\?\.id/);
  assert.doesNotMatch(app, /logicalWorkspaceId/);
  assert.match(app, /composer-menu-track/);
  assert.match(app, /conversation-work-mark/);
  assert.match(
    css,
    /\.conversation-work-mark\s*\{[\s\S]*?font-size:\s*12px/,
  );
  assert.match(app, /project-conversation-mode/);
  assert.match(app, /hydratedActorIdRef/);
  assert.match(app, /queueStateSave/);
  assert.match(app, /ConversationRow/);
  assert.match(app, /function ProjectOptionsMenu/);
  assert.match(app, /useAnchoredMenuPosition/);
  assert.match(app, /project-menu-portal/);
  assert.match(app, /function MarkdownContent/);
  assert.match(app, /remote-terminal markdown-terminal/);
  assert.match(app, /terminal \? " terminal-fence" : " code-fence"/);
  assert.match(app, /terminal \? "终端" : languageLabel\[language\] \|\| language \|\| "代码"/);
  assert.doesNotMatch(app, /markdown-code-block/);
  assert.match(app, /inline-function-field/);
  assert.match(app, /思考完成/);
  assert.match(app, /\(conversation\.messages\?\.length \?\? 0\) > 0/);
  assert.match(app, /if \(socketRef\.current === socket\)/);
  assert.match(app, /type WorkEventKind/);
  assert.match(app, /\| "approval_request"/);
  assert.match(app, /\| "file_change"/);
  assert.match(app, /\| "agent_message"/);
  assert.match(app, /\| "job_status"/);
  assert.match(app, /function fallbackConversationTitle/);
  assert.match(app, /function ScrollingTitle/);
  assert.match(app, /project-sidebar-chats-motion/);
  assert.match(app, /rail-edge-toggle/);
  assert.match(app, /remote-connection-state/);
  assert.match(app, /onSave=\{saveServerProfile\}/);
  assert.match(app, /servers: ServerProfile\[\]/);
  assert.match(app, /type: "remote\.fs\.list"/);
  assert.match(app, /type: "agent\.config\.read"/);
  assert.match(app, /type === "conversation\.title"/);
  assert.match(app, /function WorkEventFeed/);
  assert.match(app, /title: "执行计划"/);
  assert.match(app, /if \(kind === "plan"\) return Boolean\(workflowSteps\?\.length\)/);
  assert.doesNotMatch(app, /已编排/);
  assert.match(app, /callRunning && !finalAnswerStarted/);
  assert.match(app, /finalAnswerStarted=\{Boolean\(message\.content\)\}/);
  assert.match(app, /function AgentThoughtEvent/);
  assert.match(app, /复制思考内容/);
  assert.match(app, /复制 Agent 输出/);
  assert.match(app, /Agent调用中/);
  assert.match(app, /Agent调用完成/);
  assert.match(app, /const hasDetails = segments\.length > 0/);
  assert.match(app, /hasDetails && <ChevronRight className="agent-call-chevron"/);
  assert.doesNotMatch(app, /if \(!segments\.length\) return null/);
  assert.match(app, /Agent思考中/);
  assert.doesNotMatch(app, /agent-thought-label/);
  assert.match(app, /stripEasyWorkProtocolText/);
  assert.match(app, /message\.reasoningStatus !== "running"/);
  assert.match(app, /messagesPinnedToBottomRef/);
  assert.match(app, /distanceToBottom <= 72/);
  assert.doesNotMatch(app, /messagesEndRef/);
  assert.doesNotMatch(app, /Agent 回复/);
  assert.doesNotMatch(app, /step\.detail/);
  assert.match(app, /function FileChangeGroup/);
  assert.match(app, /function DiffView/);
  assert.match(app, /previous\?\.type === "files"/);
  assert.match(app, /`已编辑 \$\{files\.length\} 个文件`/);
  assert.match(app, /function useAutoDisclosure/);
  assert.match(app, /function AgentUpdateModal/);
  assert.match(app, /function conversationTitleNeedsRepair/);
  assert.match(app, /function repairConversationTitle/);
  assert.match(app, /className="trace-jump"/);
  assert.match(app, /className="trace-toggle"/);
  assert.match(app, /normalizedEventKind\(event\.kind\) === "tool_call" \|\| event\.command/);
  assert.match(app, /type: "agent\.update\.check"/);
  assert.match(app, /conversationScoped/);
  assert.match(app, /showFormConnect/);
  assert.match(app, /管理连接对话/);
  assert.match(app, /server-conversation-table/);
  assert.match(app, /已连接 \$\{boundConversations\.length\} 个对话/);
  assert.match(app, /agent\.scan\.status/);
  assert.match(app, /扫描中/);
  assert.match(app, /function AgentDirectoryPickerModal/);
  assert.match(app, /type: "agent\.uninstall"/);
  assert.doesNotMatch(app, /type: "agent\.scan"/);
  assert.match(app, /服务器地址/);
  assert.match(app, /您可以自定义对该服务器的称呼/);
  assert.match(app, /请输入您在服务器上的用户名/);
  assert.match(app, /断开 SSH/);
  assert.match(app, /running \|\| connection\.status !== "connected"/);
  assert.doesNotMatch(app, /返回连接/);
  assert.match(app, /请输入2FA验证码（可选）/);
  assert.match(
    app,
    /context !== "manage" && \(\s*<label className="field connection-otp-field">/,
  );
  assert.match(app, /placeholder="请输入当前动态验证码"/);
  assert.doesNotMatch(app, /optional-otp-field/);
  assert.match(app, /<fieldset className="ssh-authentication-panel">/);
  assert.match(app, /<legend>登录认证<\/legend>/);
  assert.match(
    css,
    /\.ssh-authentication-panel[\s\S]*background:\s*rgb\(246 241 230 \/ 62%\)/,
  );
  assert.match(app, /转换为\{mode === "chat" \? "工作" : "聊天"\}模式/);
  assert.doesNotMatch(app, /const EMPTY_CONVERSATION_ID/);
  assert.match(app, /Embedding 模型 API/);
  assert.match(app, /管理员面板/);
  assert.doesNotMatch(app, /平台 API 与 SSH/);
  assert.match(
    app,
    /provider\.audience !== "agent" && provider\.configured/,
  );
  assert.match(app, /actor\.username \|\| actor\.displayName/);
  assert.match(app, /X-EasyWork-Device-Id/);
  assert.match(app, /conversationScrollPositionsRef/);
  assert.match(app, /project-only/);
  assert.match(css, /grid-template-columns:\s*var\(--left-width\).*var\(--right-width\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.trace-detail-motion/);
  assert.match(css, /\.remote-terminal/);
  assert.match(css, /Earthsong terminal palette/);
  assert.match(css, /--terminal-green:\s*#85c54c/);
  assert.match(css, /background-color:\s*rgb\(69 64 56 \/ 92%\)/);
  assert.match(css, /backdrop-filter:\s*blur\(16px\) saturate\(118%\)/);
  assert.doesNotMatch(css, /\.markdown-code-block/);
  assert.match(css, /\.remote-connection-panel/);
  assert.match(css, /\.remote-connection-state/);
  assert.match(css, /\.rail-edge-toggle/);
  assert.match(css, /clip-path:\s*none/);
  assert.match(css, /width:\s*16px/);
  assert.match(css, /height:\s*48px/);
  assert.match(css, /backdrop-filter:\s*blur\(9px\)/);
  assert.match(css, /\.help-document \.help-keyword/);
  assert.match(css, /\.help-document \.help-markdown > h4 \+ p/);
  assert.match(
    css,
    /\.help-document \.help-markdown\s*\{[\s\S]*?font-size:\s*17px/,
  );
  assert.match(
    css,
    /\.help-document \.help-markdown > h1\s*\{[\s\S]*?font-size:\s*27px/,
  );
  assert.match(
    css,
    /\.help-document \.help-markdown > h2\s*\{[\s\S]*?font-size:\s*22px/,
  );
  assert.match(
    css,
    /\.help-document \.help-markdown > h3\s*\{[\s\S]*?font-size:\s*19px/,
  );
  assert.match(
    css,
    /\.help-document \.help-markdown > h4\s*\{[\s\S]*?font-size:\s*18px/,
  );
  assert.match(
    css,
    /\.composer-model-list > button\s*\{[\s\S]*?background:\s*transparent/,
  );
  assert.doesNotMatch(css, /\.easywork-app\.easywork-app \*\s*\{[\s\S]*?font-size/);
  assert.match(css, /\.help-keyword, \.help-emphasis\)\.tone-agent/);
  assert.match(css, /\.help-keyword, \.help-emphasis\)\.tone-api/);
  assert.match(css, /\.help-keyword, \.help-emphasis\)\.tone-connection/);
  assert.match(css, /\.admin-page/);
  assert.match(css, /\.admin-api-layout/);
  assert.match(css, /\.admin-connection-row/);
  assert.match(css, /\.agent-event-detail-motion/);
  assert.match(css, /\.file-change-list-motion/);
  assert.match(css, /\.file-diff-line\.added/);
  assert.match(css, /\.file-diff-lines[\s\S]*overscroll-behavior:\s*contain/);
  assert.match(css, /\.file-diff-line[\s\S]*width:\s*max-content;[\s\S]*min-width:\s*100%/);
  assert.match(css, /\.agent-call-motion/);
  assert.match(css, /\.reasoning-disclosure > button strong\s*\{[\s\S]*font-size:\s*16px !important/);
  assert.match(css, /\.agent-call-heading strong\s*\{[\s\S]*font-size:\s*16px !important/);
  assert.match(css, /\.agent-call-heading:hover\s*\{[\s\S]*background:\s*transparent/);
  assert.doesNotMatch(css, /\.agent-thought-label/);
  assert.match(css, /\.agent-thought-content\s*\{[\s\S]*font-size:\s*var\(--activity-title-size\) !important/);
  assert.match(css, /\.agent-thought-event\s*\{[\s\S]*border-left:/);
  assert.match(css, /\.server-conversation-action\.connect/);
  assert.match(css, /\.server-conversation-action\.disconnect/);
  assert.match(css, /--activity-title-size:\s*14\.5px/);
  assert.match(css, /--activity-meta-size:\s*12px/);
  assert.match(css, /--activity-text-inset/);
  assert.match(css, /\.agent-call \+ \.message-text[\s\S]*border-top:\s*0/);
  assert.match(css, /\.messages-scroll[\s\S]*scroll-behavior:\s*auto/);
  assert.doesNotMatch(css, /\.command-event\.expanded \.command-summary > svg/);
  assert.match(css, /\.workspace-loading-indicator/);
  assert.match(css, /\.agent-update-dialog/);
  assert.match(css, /\.unified-composer/);
  assert.match(css, /\.conversation-surface\.new-conversation/);
  assert.match(css, /\.new-conversation-mode-switch/);
  assert.match(
    css,
    /\.new-conversation \.new-conversation-mode-switch[\s\S]*width:\s*min\(228px[\s\S]*height:\s*37px/,
  );
  assert.match(
    css,
    /\.new-conversation \.messages-scroll[\s\S]*flex:\s*0 0 43%/,
  );
  assert.match(
    css,
    /\.new-conversation \.composer-zone[\s\S]*flex:\s*1 1 57%/,
  );
  assert.match(app, /className=\{`chat\$\{mode === "chat"/);
  assert.match(app, /<MessageCircle size=\{14\} \/>[\s\S]*聊天/);
  assert.match(app, /<Terminal size=\{14\} \/>[\s\S]*工作/);
  assert.match(css, /\.new-conversation-heading h1\.chat[\s\S]*27px/);
  assert.match(css, /\.new-work-setup-action\.primary-stage[\s\S]*border-radius:\s*999px/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(
    css,
    /@media \(max-width: 900px\)[\s\S]*\.left-sidebar[\s\S]*transform:\s*translateX\(-104%\)/,
  );
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.provider-manager[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)/,
  );
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.remote-directory-picker[\s\S]*100dvh/,
  );
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.server-conversation-row[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/,
  );
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.new-conversation \.messages-scroll\s*\{[\s\S]*flex:\s*1 1 auto/,
  );
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.new-conversation \.composer-zone\s*\{[\s\S]*position:\s*absolute;[\s\S]*bottom:\s*0/,
  );
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.new-conversation \.empty-chat\s*\{[\s\S]*justify-content:\s*center/,
  );
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.match(css, /\.new-work-setup-value\.workspace-ready/);
  assert.match(css, /\.help-page[\s\S]*background-attachment:\s*local/);
  assert.match(css, /\.account-modal-authenticated/);
  assert.match(
    css,
    /\.account-modal \.account-tabs[\s\S]*background:\s*transparent/,
  );
  assert.match(css, /\.unified-composer\.multiline/);
  assert.match(css, /max-height:\s*96px/);
  assert.match(css, /\.unified-composer\.expanded/);
  assert.match(css, /grid-template-areas:\s*"add input model send"/);
  assert.match(css, /"input input input input"[\s\S]*"add spacer model send"/);
  assert.match(css, /\.composer-menu-popover\.show-skills/);
  assert.match(css, /\.message\.user \.message-text\s*\{[\s\S]*font-size:\s*17px !important/);
  assert.match(css, /\.markdown-content:not\(\.compact\)[\s\S]*table\s*\{[\s\S]*font-size:\s*16px !important/);
  assert.match(css, /\.markdown-content\s*\{[\s\S]*white-space:\s*normal/);
  assert.match(css, /\.markdown-content li > p \+ :is\(ul, ol\)/);
  assert.match(css, /code\.inline-function-field\s*\{[\s\S]*font-size:\s*0\.9em !important/);
  assert.match(css, /code\.inline-function-field\.tone-4/);
  assert.match(css, /\.quick-connection-actions/);
  assert.match(css, /\.server-detail-tabs/);
  assert.match(css, /\.server-conversation-panel/);
  assert.match(css, /\.modal-card\.modal-wide:has\(\.server-manager\)/);
  assert.match(css, /\.project-sidebar-chats-motion/);
  assert.doesNotMatch(css, /\.workspace-picker-modal/);
  assert.doesNotMatch(css, /\.workspace-picker-button/);
  assert.match(css, /\.workspace-rail-panel/);
  assert.doesNotMatch(css, /\.context-meters/);
  assert.doesNotMatch(css, /\.context-meter-row/);
  assert.match(css, /\.web-context-ring[\s\S]*#8564b4/);
  assert.match(css, /\.provider-manager/);
  assert.match(css, /\.workspace-path-viewport\.scrollable:hover code/);
  assert.match(
    css,
    /Adaptive composer and the four-section Work rail[\s\S]*grid-template-rows:\s*auto auto auto minmax\(0, 1fr\)/,
  );
  assert.match(css, /\.context-usage-hero/);
  assert.match(css, /\.agent-context-ring/);
  assert.match(css, /\.agent-context-controls/);
  assert.match(css, /\.agent-inline-install/);
  assert.match(css, /\.agent-menu-option\.danger/);
  assert.match(app, /\) : agent\.managed \? \([\s\S]*agent-config-shortcut/);
  assert.match(css, /\.work-connection-copy small/);
  assert.match(css, /\.work-connection-status-line/);
  assert.match(css, /\.conversation-mode-stack/);
  assert.match(
    css,
    /\.conversation-surface\.workspace-toolbar[\s\S]*padding-top:\s*100px/,
  );
  assert.match(css, /grid-template-rows:\s*0fr/);
  assert.match(css, /\.project-sidebar-chats-motion\.expanded/);
  assert.match(css, /\.conversation-toolbar::after\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /\.remote-file-manager/);
  assert.match(css, /@keyframes chat-title-scroll/);
  assert.match(gateway, /keepaliveIntervalSeconds:\s*60/);
  assert.match(gateway, /keepaliveInterval:\s*sshPolicy\.keepaliveIntervalSeconds \* 1000/);
  assert.match(gateway, /hostVerifier/);
  assert.match(gateway, /Access-Control-Allow-Private-Network/);
  assert.match(gateway, /\/api\/settings\/provider\/models/);
  assert.match(gateway, /\.easywork\/agents\/opencode\/bin/);
  assert.match(gateway, /\.config\/opencode\/opencode\.json/);
  assert.match(gateway, /\.local\/share\/opencode/);
  assert.match(gateway, /remote\.fs\.upload/);
  assert.match(gateway, /connections\.snapshot/);
  assert.match(gateway, /conversation\.title/);
  assert.match(gateway, /const sshWorkerPool = new Map/);
  assert.match(gateway, /url\.pathname === "\/api\/admin\/overview"/);
  assert.match(gateway, /url\.pathname === "\/api\/admin\/platform"/);
  assert.match(gateway, /url\.pathname === "\/api\/admin\/ssh-policy"/);
  assert.match(gateway, /path\.join\(DATA_ROOT, "devices"/);
  assert.match(gateway, /async function ensureInitialAdministrator/);
  assert.match(gateway, /idleTtlMinutes:\s*30 \* 24 \* 60/);
  assert.match(gateway, /function cleanupIdleSshWorkers/);
  assert.match(gateway, /function publishWorkerEvent/);
  assert.match(gateway, /url\.pathname === "\/api\/conversations\/action"/);
  assert.match(gateway, /\["branch", "edit", "reset", "rewind"\]/);
  assert.match(gateway, /rewoundToMessageId/);
  assert.doesNotMatch(gateway, /url\.pathname === "\/api\/conversations\/branch"/);
  assert.match(gateway, /worker\.sockets\.delete\(socket\)/);
  assert.doesNotMatch(gateway, /SSH_RECONNECT_GRACE_MS/);
  assert.match(gateway, /deviceToken/);
  assert.match(gateway, /resolveAgentArtifact/);
  assert.match(gateway, /remoteSftpFastPut/);
  assert.match(gateway, /正在校验/);
  assert.doesNotMatch(gateway, /opencode\.ai\/install/);
  assert.match(gateway, /agentSessions:\s*new Map/);
  assert.match(gateway, /function workspaceIdFor/);
  assert.match(gateway, /function sshServerIdentity/);
  assert.match(gateway, /function workspaceVersionDomainIdFor/);
  assert.match(gateway, /function workspaceRunConflict/);
  assert.match(gateway, /DEFAULT_AGENT_CONTEXT_LIMIT\s*=\s*200_000/);
  assert.match(gateway, /async function inspectNativeAgentContext/);
  assert.match(gateway, /"ready-no-session"/);
  assert.match(gateway, /status:\s*knownAgent \? "service-unavailable" : "unreadable"/);
  assert.match(gateway, /url\.pathname === "\/api\/workspaces"/);
  assert.match(gateway, /workspaceId:\s*workerTask\.workspaceId/);
  assert.doesNotMatch(gateway, /logicalWorkspaceId/);
  assert.match(gateway, /agentUpdates:\s*new Map/);
  assert.match(gateway, /agent\.update\.check/);
  assert.match(gateway, /agent\.uninstall/);
  assert.doesNotMatch(gateway, /payload\.type === "agent\.scan"/);
  assert.match(gateway, /deployManagedAgentArtifact/);
  assert.match(gateway, /errorPayload\?\.data\?\.message/);
  assert.match(gateway, /readOpenCodeFailureLog/);
  assert.match(gateway, /persistServerProfile/);
  assert.match(gateway, /"providers",[\s\S]*"activeProviderId"/);
  assert.match(gateway, /providerApiKeys/);
  assert.match(gateway, /providerId:\s*provider\.id/);
  assert.match(gateway, /function normalizeAgentPlanSteps/);
  assert.match(gateway, /sourceId: "agent-native-plan"/);
  assert.match(gateway, /title: "执行计划"/);
  assert.match(gateway, /await agentPromptWithNativePlanning\(/);
  assert.match(gateway, /runWorkHandoffModel/);
  assert.match(gateway, /kind: "reasoning"/);
  assert.match(gateway, /renderPromptTemplate\("web\/work-context-router\.md"/);
  assert.doesNotMatch(gateway, /planWorkSteps|agentPromptWithWorkflow/);
  assert.doesNotMatch(gateway, /type: "workflow\.step"/);
  assert.doesNotMatch(gateway, /\["\/ws",\s*"\/easywork-ws"\]/);

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
  assert.match(viteConfig, /"\/easywork-ws"/);
  assert.match(viteConfig, /easywork-websocket-tunnel/);
  assert.doesNotMatch(viteConfig, /hosting\.json|sites\(\)/);
  assert.match(gitignore, /^\/frp\/$/m);
  assert.match(example, /REPLACE_WITH_FRP_TOKEN/);
  assert.doesNotMatch(example, /auth\.token\s*=\s*"[a-f0-9]{32,}"/i);

  await assert.rejects(access(new URL("../.openai/hosting.json", import.meta.url)));
  await assert.rejects(access(new URL("../build/sites-vite-plugin.ts", import.meta.url)));
});
