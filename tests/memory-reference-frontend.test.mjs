import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewPath = new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url);
const viewStylePath = new URL("../app/easywork/features/conversation/ConversationView.module.css", import.meta.url);
const timelinePath = new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url);
const adminPath = new URL("../app/easywork/features/admin/AdminView.tsx", import.meta.url);
const servicesPath = new URL("../gateway/core/runtime/services.mjs", import.meta.url);
const toolsPath = new URL("../gateway/core/web-agent/tools.mjs", import.meta.url);

test("Composer 的 @ 选择是结构化引用并在用户消息中保留冻结标题", async () => {
  const [view, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8")]);
  assert.match(view, /\/api\/conversation-references\/candidates/);
  assert.match(view, /references\.map\(\(\{ conversationId: referencedConversationId \}\)/);
  assert.match(view, /type: "conversation", conversationId: referencedConversationId/);
  assert.match(view, /message\.references\?\.length/);
  assert.match(view, /sessionStorage\.setItem\(referenceStorageKey, JSON\.stringify\(references\)\)/);
  assert.doesNotMatch(view, /按标题匹配/);
  assert.match(view, /className=\{styles\.composerInput\}/);
  assert.match(view, /className=\{styles\.inlineReferences\}/);
  assert.doesNotMatch(view, /className=\{styles\.referenceInlineRemove\}/);
  assert.doesNotMatch(view, /<span>@\{reference\.title\}<\/span>/);
  assert.match(view, /<span>\{reference\.title\}<\/span>/);
  assert.match(view, /function ConversationReferenceLink/);
  assert.match(view, /<ConversationReferenceLink key=\{reference\.referenceId\} reference=\{reference\}/);
  assert.match(view, /<ConversationReferenceLink key=\{reference\.conversationId\} reference=\{reference\}/);
  assert.doesNotMatch(styles, /\.messageReferences button\s*\{/);
  assert.match(view, /event\.currentTarget\.selectionStart === 0 && event\.currentTarget\.selectionEnd === 0/);
  assert.match(styles, /\.referenceMenu\s*\{/);
  assert.match(styles, /\.referenceMenu\s*\{[^}]*left:55px;/s);
  assert.match(styles, /\.referenceList::-webkit-scrollbar-button\s*\{[^}]*display:none;/s);
  assert.match(styles, /\.referenceInline\s*\{/);
  assert.doesNotMatch(styles, /\.referenceInlineRemove\s*\{/);
  assert.doesNotMatch(styles, /\.referenceChip\s*\{/);
});

test("分支来源使用紧凑系统文案并让预览省略号保持在成对括号内", async () => {
  const [view, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8")]);
  assert.match(view, /className=\{styles\.originSystem\}>该对话基于/);
  assert.match(view, /className=\{styles\.originPreview\}>（<span>\{detail\.summary\.origin\.questionPreview\}…<\/span>）<\/span>/);
  assert.match(view, /className=\{styles\.originSystem\}>创建/);
  assert.match(styles, /\.conversationOrigin\s*\{[^}]*gap:2px;[^}]*color:var\(--ew-ink\);/s);
  assert.match(styles, /\.originPreview > span\s*\{[^}]*text-overflow:ellipsis;/s);
});

test("Work 固定状态在模型资料前注入并以独立时间线条目展示", async () => {
  const [services, timeline, view] = await Promise.all([readFile(servicesPath, "utf8"), readFile(timelinePath, "utf8"), readFile(viewPath, "utf8")]);
  assert.match(services, /kind: "run\.context\.state"/);
  assert.match(services, /\[workEnvironment\.rendered, skillCatalog, resourceCatalog, conversationReferenceCatalog\]/);
  assert.match(services, /const selectedServerLabel = String\(routing\.serverLabel/);
  assert.match(services, /const configuredServerName = String\(raw\?\.server\?\.profile\?\.name/);
  assert.match(timeline, /已查阅当前状态/);
  assert.doesNotMatch(timeline, /未检测到调度器|调度器未确定/);
  assert.match(timeline, /\["none", "unknown"\]\.includes\(schedulerType\)/);
  assert.match(timeline, /entry\.type === "state"/);
  assert.match(timeline, /run\.context\.state/);
  assert.match(services, /const usableRoutedWorkspacePath = routedWorkspacePath[\s\S]+?getWorkspace\(scope\.workspaceId\)/);
  assert.match(view, /semanticWorkspacePath !== semanticWorkspaceId/);
  assert.match(view, /else delete scope\.workspacePath/);
});

test("记忆与显式对话引用可本轮整理，界面保留原标题并标识整理内容", async () => {
  const [timeline, tools] = await Promise.all([readFile(timelinePath, "utf8"), readFile(toolsPath, "utf8")]);
  assert.match(tools, /handoff_rewrite_candidate/);
  assert.match(tools, /version: "record-v1"/);
  assert.match(tools, /conversation-reference:\$\{sourceConversationId\}:\$\{sourceSnapshotId\}:\$\{turnId\}/);
  assert.match(timeline, /record\.title \|\| record\.semanticKey/);
  assert.doesNotMatch(timeline, /restoreLegacyMemoryTitles/);
  assert.match(timeline, /本轮整理/);
});

test("Embedding 管理页把文件分块与记忆混合召回配置分开保存", async () => {
  const admin = await readFile(adminPath, "utf8");
  assert.match(admin, /Embedding 用途配置/);
  assert.match(admin, />文件<\/button>/);
  assert.match(admin, />记忆<\/button>/);
  assert.match(admin, /memory:\s*\{/);
  for (const field of ["vectorWeight", "lexicalWeight", "titleWeight", "minimumScore", "diversityLambda", "recallLimit", "resultLimit", "tokenBudget", "pageSize"]) {
    assert.match(admin, new RegExp(`${field}:`));
  }
});
