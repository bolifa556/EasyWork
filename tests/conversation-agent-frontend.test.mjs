import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeConversationEvents, retainConversationEvents } from "../app/easywork/features/conversation/conversation-event-retention.mjs";

const viewPath = new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url);
const viewStylePath = new URL("../app/easywork/features/conversation/ConversationView.module.css", import.meta.url);
const controlPath = new URL("../app/easywork/features/conversation/AgentControl.tsx", import.meta.url);
const controlStylePath = new URL("../app/easywork/features/conversation/AgentControl.module.css", import.meta.url);
const configurationCachePath = new URL("../app/easywork/features/conversation/agent-configuration-cache.ts", import.meta.url);
const shellPath = new URL("../app/easywork/shell/AppShell.tsx", import.meta.url);
const shellStylePath = new URL("../app/easywork/shell/AppShell.module.css", import.meta.url);
const baseStylePath = new URL("../app/easywork/styles/base.css", import.meta.url);
const connectionDialogPath = new URL("../app/easywork/features/conversation/ConversationConnectionDialog.tsx", import.meta.url);
const webContextDialogPath = new URL("../app/easywork/features/conversation/WebContextDialog.tsx", import.meta.url);
const serverManagerPath = new URL("../app/easywork/features/servers/ServerManager.tsx", import.meta.url);
const cacheEventsPath = new URL("../app/easywork/runtime/cacheEvents.ts", import.meta.url);
const timelinePath = new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url);
const copySource = await readFile(new URL("../app/easywork/features/conversation/conversation-copy.mjs", import.meta.url), "utf8");
const timelineStylePath = new URL("../app/easywork/features/conversation/ConversationTimeline.module.css", import.meta.url);
const markdownPath = new URL("../app/easywork/features/conversation/MarkdownContent.tsx", import.meta.url);
const markdownStylePath = new URL("../app/easywork/features/conversation/MarkdownContent.module.css", import.meta.url);
const modalPath = new URL("../app/easywork/ui/Modal.tsx", import.meta.url);
const resourcesPath = new URL("../app/easywork/features/conversation/ComposerResources.tsx", import.meta.url);
const workbenchPath = new URL("../app/easywork/features/workbench/WorkbenchDrawer.tsx", import.meta.url);
const runtimePath = new URL("../gateway/core/runtime/runtime.mjs", import.meta.url);
const webAgentRuntimePath = new URL("../gateway/core/web-agent/runtime.mjs", import.meta.url);
const servicesPath = new URL("../gateway/core/runtime/services.mjs", import.meta.url);
const platformStorePath = new URL("../gateway/core/platform/store.mjs", import.meta.url);
const webToolsPath = new URL("../gateway/core/web-agent/tools.mjs", import.meta.url);

test("思考与正文交错时保留所有思考段，仅替换同段的累积快照", () => {
  const make = (sequence, kind, content, realtimeStreamKey) => ({
    eventId: `event-${sequence}`, topic: "conversation:one", sequence, occurredAt: "2026-09-03T00:00:00.000Z",
    kind, ids: { runId: "run-one" }, payload: { content, realtimeStreamKey },
  });
  const first = make(1, "run.reasoning.delta", "先", "reasoning:0:1");
  const expanded = make(2, "run.reasoning.delta", "先确认问题。", "reasoning:0:1");
  const output = make(3, "run.output.delta", "你好", "output:0:3");
  const tail = make(4, "run.reasoning.delta", "\n", "reasoning:0:4");
  const completed = make(5, "run.completed", "", undefined);
  let live = [];
  for (const event of [first, expanded, output, tail, completed]) live = mergeConversationEvents(live, [event]);
  assert.deepEqual(live.map((event) => event.sequence), [2, 3, 4, 5]);
  assert.equal(live[0].payload.content, "先确认问题。");
  assert.deepEqual(mergeConversationEvents([], [expanded, output, tail, completed]), live);
  assert.equal(mergeConversationEvents(live, [expanded, output, tail, completed]), live, "重复回放不触发重新渲染");
  // Also tolerate a persisted journal produced before segment-specific keys.
  const legacy = [expanded, output, { ...tail, payload: { ...tail.payload, realtimeStreamKey: expanded.payload.realtimeStreamKey } }, completed];
  assert.deepEqual(mergeConversationEvents([], legacy).map((event) => event.sequence), [2, 3, 4, 5]);
});

test("EasyWork Conversation 使用持久事件回放与唯一 Timeline，并保持严格生产顺序", async () => {
  const [view, timeline, runtime] = await Promise.all([readFile(viewPath, "utf8"), readFile(timelinePath, "utf8"), readFile(runtimePath, "utf8")]);
  assert.match(runtime, /\/api\/conversations\/:id\/events/);
  assert.match(runtime, /\/api\/tasks\/:id\/events/);
  assert.match(view, /timelineEvents=\{timelineByAssistantMessage\.get\(message\.id\)\}/);
  assert.match(view, /orphanTimelineByUserMessage/);
  assert.match(view, /groupConversationTimeline\(messages, events, tasks\)/);
  assert.match(copySource, /const runStartByUserMessage = new Map[\s\S]+?event\.kind === "run\.started" && event\.ids\.sourceMessageId === sourceId/);
  assert.match(copySource, /if \(taskId && event\.ids\.taskId\)[\s\S]+?event\.ids\.taskId === taskId && event\.ids\.sourceMessageId === sourceId/);
  assert.match(copySource, /if \(event\.ids\.sourceMessageId\)[\s\S]+?event\.ids\.sourceMessageId !== sourceId/);
  assert.match(view, /message\.role === "user" && orphanTimelineByUserMessage\.has\(message\.id\)/);
  assert.match(view, /!user && \(timelineEvents\?\.length \|\| timelineLoading\) \? <ConversationTimeline/);
  assert.doesNotMatch(view, /message\.role === "user" && timelineByUserMessage\.has/);
  assert.match(view, /const streamingMessagePersisted = classifiedOutput\.streamingMessageId[\s\S]+?const visibleStreamingFinal = streamingMessagePersisted \? "" : classifiedOutput\.streamingFinal/);
  assert.match(view, /const pendingTimelineEvents = latestResponseUserId && !usersWithAssistant\.has\(latestResponseUserId\)/);
  assert.match(view, /event\.kind === "conversation\.title\.updated"[\s\S]+?refreshBootstrap/);
  assert.doesNotMatch(view, /function EventRow|activityTimeline/);
  assert.match(timeline, /occurredAt\.localeCompare/);
  assert.match(timeline, /eventPayload\.heartbeat === true && \/-heartbeat-/);
  assert.match(timeline, /event\.kind === "run\.reasoning\.delta"/);
  assert.match(timeline, /event\.kind !== "run\.context\.read"/);
  assert.doesNotMatch(timeline, /run\.tool\.(?:started|completed|failed)/);
  assert.match(timeline, /function WorkHandoff/);
  assert.doesNotMatch(timeline, /TaskPlanSummary|执行计划/);
  assert.match(view, /function ComposerTaskPlan/);
  assert.match(view, /function TaskPlanList/);
});

test("对话删除或重命名只按事件失效服务器详情缓存，不引入轮询", async () => {
  const [shell, servers, events] = await Promise.all([
    readFile(shellPath, "utf8"),
    readFile(serverManagerPath, "utf8"),
    readFile(cacheEventsPath, "utf8"),
  ]);
  assert.match(events, /easywork:conversations-changed/);
  assert.match(shell, /announceConversationsChanged\(\{ conversationId: item\.id, kind: "deleted", optimistic: true \}\)/);
  assert.match(shell, /announceConversationsChanged\(\{ conversationId: editing\.item\.id, kind: "renamed", conversation: result\.data\.conversation \}\)/);
  assert.match(servers, /addEventListener\(CONVERSATIONS_CHANGED_EVENT, changed\)/);
  assert.match(servers, /const changed = \(event: Event\) =>/);
  assert.match(servers, /if \(detail\?\.optimistic\) return/);
  assert.doesNotMatch(servers, /setInterval/);
});

test("远程服务器页标题不重复展示列表数量", async () => {
  const servers = await readFile(serverManagerPath, "utf8");
  assert.match(servers, /<h1>远程服务器<\/h1><\/div>/);
  assert.doesNotMatch(servers, /<h1>远程服务器<\/h1><span>\{servers\.length\}<\/span>/);
});

test("恢复后的终态任务不会把工作输入框永久误判为正在思考", async () => {
  const [view, timeline] = await Promise.all([readFile(viewPath, "utf8"), readFile(timelinePath, "utf8")]);
  assert.match(view, /latestConversationTask\?\.sourceMessageId === latestResponseUserId/);
  assert.match(view, /\["completed", "failed", "cancelled", "interrupted"\]\.includes\(latestConversationTask\.status\)/);
  assert.match(view, /\["run\.persisted", "run\.suspended", "run\.failed", "run\.aborted", "run\.superseded"\]\.includes\(event\.kind\)/);
  assert.match(view, /function latestWebRunEvents[\s\S]+?if \(ordered\[index\]\.kind === "run\.started"\) startedIndex = index/);
  assert.match(view, /const latestResponseWebRunEvents = latestWebRunEvents\(pendingTimelineEvents \|\| \[\]\)/);
  assert.match(view, /const latestResponseRunSettled = latestResponseWebRunEvents\.some/);
  assert.match(view, /&& !latestResponseTaskSettled[\s\S]+?&& !latestResponseRunSettled/);
  assert.match(view, /const settledTaskIds = new Set\(messages[\s\S]+?message\.role === "assistant" && Boolean\(message\.taskId\)/);
  assert.match(view, /settledTaskIds=\{settledTaskIds\}/);
  assert.match(timeline, /settledTaskIds\.has\(fallbackTaskId\) \? "completed" : "queued"/);
  assert.match(timeline, /else if \(taskId && settledTaskIds\.has\(taskId\)\) status = "completed"/);
  assert.match(timeline, /function terminalWebTaskStatus\(events: RealtimeEnvelope\[], taskId: string\)/);
  assert.match(timeline, /\["run\.persisted", "run\.superseded"\]\.includes\(event\.kind\)\) status = "completed"/);
  assert.match(timeline, /event\.kind === "run\.suspended"[\s\S]+?"interrupted"/);
  assert.match(timeline, /remoteTaskStatus\(remoteAll, taskById, remoteTaskId, settledTaskIds, webTerminalStatus\)/);
});

test("工作目录切换只同步共享路由，不因打开网页对话自动物化历史版本", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /workspaceRouteSyncPending = useRef<Map<string, Promise<WorkspaceRouteSnapshot \| null>>>/);
  assert.match(view, /connectionEnabled: conversationConnectionEnabled && selectedServer\?\.status === "connected"/);
  assert.doesNotMatch(view, /versioning\/activate/);
  assert.match(view, /setWorkspaceDirectoryLoading\(true\)/);
  assert.match(view, /finally \{\s*setWorkspaceDirectoryLoading\(false\)/);
  assert.match(view, /aria-pressed=\{workspaceDirectoryActive\} aria-busy=\{workspaceDirectoryLoading\}/);
  assert.match(view, /onClick=\{\(\) => void toggleWorkspaceDirectory\(\)\}/);
  assert.doesNotMatch(view, /modeMenuOpen|modePopover|requestWorkToChat|convertWorkToChat|转换为聊天|正在切换工作目录/);
  assert.match(view, /disabled=\{workspaceDirectoryLoading \|\| \(!workspaceDirectoryActive/);
});

test("聊天内容和输入框独立排布，文件预览限制在右侧主内容区", async () => {
  const [view, styles, preview] = await Promise.all([
    readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8"),
    readFile(new URL("../app/easywork/features/workspace/ConversationWorkspacePreview.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(view, /followConversationScroll\(node, content, conversationScrollPositions\.get\(conversationId\)/);
  assert.match(view, /className=\{styles\.messageList\} ref=\{messageContent\}/);
  assert.match(styles, /\.stage\s*\{[^}]*grid-template-rows:minmax\(0,1fr\) auto;/s);
  assert.match(styles, /\.stageContent\s*\{[^}]*min-height:0;[^}]*grid-template-rows:minmax\(0,1fr\) auto;/s);
  assert.match(styles, /\.composerWrap\s*\{[^}]*position:relative;/s);
  assert.doesNotMatch(styles, /conversation-workbench-height/);
  assert.match(preview, /\.previewPanel\s*\{[^}]*position:absolute;[^}]*inset:0;[^}]*width:100%;[^}]*height:100%;/s);
  assert.doesNotMatch(preview, /position:fixed|width:100vw|height:100dvh/);
  assert.doesNotMatch(preview, /inset:var\(--conversation-header-height,0\) 0 0/);
});

test("工作入口切回对话时复用文件预览的未保存修改确认", async () => {
  const [view, controller, preview] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(new URL("../app/easywork/features/workspace/ConversationWorkspacePreview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/easywork/features/viewers/FilePreviewPanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /workspacePreviewRef\.current\.requestCloseAll\(returnToConversation\)/);
  assert.match(controller, /requestCloseAll: \(afterClose\) => requestCloseFilePreviews\(conversationId, afterClose\)/);
  assert.match(preview, /statuses\[id\]\?\.dirty/);
  assert.match(preview, /setPendingClose\(\{ ids, afterClose \}\)/);
  assert.match(preview, /ids\.forEach\(closeFilePreview\); afterClose\?\.\(\)/);
});

test("自动工作区建立后切换 Agent 使用当前真实路由而不要求刷新页面", async () => {
  const [view, control] = await Promise.all([readFile(viewPath, "utf8"), readFile(controlPath, "utf8")]);
  const switchSection = view.slice(view.indexOf("const switchAgent = async"), view.indexOf("const storeAgentOptions"));
  const selectSection = control.slice(control.indexOf("const selectAgent = async"), control.indexOf("const completeSetupConfig"));
  assert.match(switchSection, /const currentWorkspaceId = routedWorkspaceId/);
  assert.match(switchSection, /workspaceId: currentWorkspaceId/);
  assert.match(switchSection, /setWorkspace\(currentWorkspaceId\)/);
  assert.match(switchSection, /setWorkspacePath\(currentWorkspacePath\)/);
  assert.doesNotMatch(switchSection, /workspace === VIRTUAL_WORKSPACE/);
  assert.doesNotMatch(switchSection, /requestRouteSwitchConfirmation/);
  assert.match(view, /onBeforeSelect=\{\(\) => requestRouteSwitchConfirmation\("agent"\)\}[\s\S]+?onSelect=\{switchAgent\}/);
  assert.ok(selectSection.indexOf("await onBeforeSelect(agent.agentId)") < selectSection.indexOf("setSelectingAgentId(agent.agentId)"));
  assert.match(selectSection, /agent\.agentId === selectedAgentId[\s\S]+?setOpen\(false\)[\s\S]+?setPage\("root"\)/);
});

test("网页工具只发布语义结果，远端失败原因进入对话时间线", async () => {
  const [timeline, styles, services, webTools] = await Promise.all([
    readFile(timelinePath, "utf8"),
    readFile(timelineStylePath, "utf8"),
    readFile(servicesPath, "utf8"),
    readFile(webToolsPath, "utf8"),
  ]);
  assert.match(webTools, /requires explicit semantic present\(\) and render\(\)/);
  assert.match(webTools, /semanticMemory/);
  assert.match(webTools, /semanticResources/);
  assert.match(webTools, /semanticConversation/);
  assert.match(webTools, /semanticSkills/);
  assert.match(webTools, /handoff: definition\.handoff !== false/);
  assert.match(webTools, /timelineRead: Boolean\(definition\.timelineRead\)/);
  assert.match(webTools, /name: "skill_search"[\s\S]+?timelineRead: true/);
  assert.doesNotMatch(webTools.match(/name: "skill_list"[\s\S]+?registry\.register\(\{/s)?.[0] || "", /timelineRead: true/);
  assert.match(services, /kind: interrupted \? "run\.aborted" : "run\.failed"/);
  assert.match(services, /status === "completed" && !observation\.report/);
  assert.match(timeline, /failure: !handoff && formalTerminal\?\.kind === "run\.failed"/);
  assert.match(timeline, /const rawAbortReason = formalTerminal\?\.kind === "run\.aborted"/);
  assert.match(timeline, /abortReason: rawAbortReason\.trim\(\) === "请求已停止" \? "" : rawAbortReason/);
  assert.match(timeline, /const terminalReason = trace\.failure \|\| trace\.abortReason/);
  assert.match(timeline, /if \(!trace\.started && !terminalReason\) return null/);
  assert.match(timeline, /\["append", "resume"\]\.includes\(String\(payload\.operation \|\| ""\)\)/);
  assert.match(timeline, /role="alert"/);
  assert.match(timeline, /function BackgroundTrace[\s\S]+?<span className=\{styles\.backgroundLabel\}>已查阅背景<\/span>/);
  assert.match(timeline, /const displayItems = groupBackgroundResults\(results\)/);
  assert.match(timeline, /function BackgroundConversation[\s\S]+?<small>对话<\/small><span>\{group\.title\}<\/span>/);
  assert.doesNotMatch(timeline.match(/function BackgroundConversation[\s\S]+?\n}/)?.[0] || "", /useTimelineDetails|DisclosureMotion|group\.results\.map/);
  assert.match(timeline, /event\.kind !== "run\.context\.read"/);
  assert.match(timeline, /previous\?\.type === "background"\) previous\.reads\.push\(read\)/);
  assert.match(timeline, /entries\.push\(\{ type: "background", id: `background:\$\{read\.id\}`, reads: \[read\] \}\)/);
  assert.doesNotMatch(timeline, /已查询|已搜索|未查询到相关内容|查询失败|WEB_SEARCH_TOOLS|SearchTrace/);
  assert.match(timeline, /const handoffTerminal = handoff[\s\S]+?run\.context\.completed[\s\S]+?run\.handoff\.ready/);
  assert.match(timeline, /const terminal = handoffTerminal \?\? persisted \?\? formalTerminal/);
  assert.match(timeline, /reads\.flatMap\(\(item\) => backgroundItems\(item\.output\)/);
  assert.match(timeline, /for \(const event of orderedEvents\(events\)\)/);
  assert.match(styles, /\.runFailure/);
  assert.match(styles, /\.handoff\s*\{[^}]*margin:\s*1px 0 3px;/s);
  assert.match(styles, /\.handoffHeading\s*\{[^}]*width:max-content;[^}]*grid-template-columns:22px minmax\(0,auto\) 14px;[^}]*border:0;[^}]*background:transparent;/s);
  assert.match(styles, /\.handoffRail\s*\{[^}]*margin-left:var\(--timeline-detail-inset\);[^}]*border:0;[^}]*padding:0;/s);
  assert.match(timeline, /className=\{styles\.handoffBody\}/);
  assert.match(timeline, /className=\{styles\.handoffHeading\} aria-expanded=\{open\}/);
  assert.match(timeline, /className=\{styles\.handoffChevron\}/);
  assert.match(styles, /\.handoffOpen \.handoffChevron\s*\{[^}]*rotate\(90deg\)/s);
  assert.match(styles, /\.workflow\s*\{[^}]*--timeline-heading-size:17px;[^}]*--timeline-title-size:15\.5px;[^}]*--timeline-body-size:15\.5px;[^}]*--timeline-detail-size:14px;[^}]*--timeline-code-size:13px;[^}]*--timeline-meta-size:12px;[^}]*--timeline-body-leading:1\.62;/s);
  assert.match(styles, /\.handoffLabel\s*\{[^}]*font-size:var\(--timeline-title-size\);[^}]*font-weight:400;/s);
  assert.match(styles, /\.backgroundHeading\s*\{[^}]*grid-template-columns:22px minmax\(0,auto\) 14px;[^}]*font-weight:400;/s);
  assert.doesNotMatch(styles, /\.webSearch|\.searchResult|\.searchError/);
  assert.match(styles, /\.handoff p\s*\{[^}]*font-size:var\(--timeline-detail-size\);[^}]*line-height:var\(--timeline-body-leading\);/s);
  assert.match(styles, /\.groupHeading strong\s*\{[^}]*font-size:var\(--activity-title-size\);[^}]*font-weight:630;/s);
});

test("远端中断异步失败会在输入栏上方短暂提示且不重放历史告警", async () => {
  const [view, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8")]);
  assert.match(view, /operation !== "interrupt" && operation !== "startup-interrupt-cleanup"/);
  assert.match(view, /failureMessage\(payload\.warning\) \|\| failureMessage\(payload\.failure\)/);
  assert.match(view, /function isRecentEvent[\s\S]+?Date\.now\(\) - timestamp <= lifetimeMs/);
  assert.match(view, /window\.setTimeout\(\(\) => setInterruptError\(null\), 5_000\)/);
  assert.match(view, /<div className=\{styles\.composerNotice\} role="alert">/);
  assert.match(styles, /\.composerNotice\s*\{/);
});

test("表格自适应列宽且不产生横向滚动条，远端 Skill 逐项展示并可展开详情", async () => {
  const [markdown, markdownStyles, timeline, timelineStyles] = await Promise.all([
    readFile(markdownPath, "utf8"),
    readFile(markdownStylePath, "utf8"),
    readFile(timelinePath, "utf8"),
    readFile(timelineStylePath, "utf8"),
  ]);
  assert.doesNotMatch(markdown, /passVerticalWheelToPage|onWheel=/);
  assert.match(markdownStyles, /\.tableWrap[^}]+overflow:\s*hidden/s);
  assert.match(markdownStyles, /\.tableStacked td::before[^}]+data-column-label/s);
  assert.match(timeline, /function mergeHandoffSkillDetails[\s\S]+?semanticResultText\("skills", skill\)/);
  assert.match(timeline, /const eventDetail = String\(record\.detail \|\| ""\)\.trim\(\)/);
  assert.match(timeline, /nonSkillReferences\.length === 1 && !nonSkillReferences\[0\]\.detail/);
  assert.match(timeline, /handoffReferences\(payload\.references, selectedSkillDetails\)/);
  assert.match(timeline, /kind\.toLocaleLowerCase\(\) === "skill"[\s\S]+?HandoffDetailReference/);
  assert.match(timeline, /function HandoffDetailReference[\s\S]+?reference\.detail[\s\S]+?<MarkdownContent content=\{reference\.detail!\} compact activity \/>/);
  assert.match(timeline, /if \(kind\.toLocaleLowerCase\(\) === "skill"\) return <>\{references\.map/);
  assert.match(timelineStyles, /\.handoffRail\s*\{[^}]*margin-left:var\(--timeline-detail-inset\);/);
  assert.match(timelineStyles, /\.handoffReference\s*\{[^}]*padding:0 38px 0 12px;[^}]*font-size:var\(--timeline-detail-size\);[^}]*white-space:\s*nowrap/s);
  assert.match(timelineStyles, /\.handoffReferenceKind\s*\{[^}]*font-size:var\(--timeline-detail-size\);/s);
  assert.match(timelineStyles, /\.handoffSkillHeading\s*\{[^}]*grid-template-columns:auto minmax\(0,auto\) 14px;[^}]*border-left:3px solid #9dbba4;/s);
  assert.match(timeline, /<DisclosureMotion open=\{expandable && open\} className=\{styles\.handoffSkillMotion\}/);
});

test("思考位于 EasyWork 标题下方，功能栏收纳箭头保持水平居中", async () => {
  const [view, viewStyles, timelineStyles] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(viewStylePath, "utf8"),
    readFile(timelineStylePath, "utf8"),
  ]);
  assert.match(view, /user \? <div className=\{styles\.messageHead\}>你[\s\S]+?directRemoteAppend \? null : <div className=\{styles\.messageHead\}>[\s\S]+?EasyWork/);
  assert.match(view, /showPendingAssistant[\s\S]+?isDirectRemoteAppendTimeline\(pendingTimelineEvents \|\| \[\]\) \? null : <div className=\{styles\.messageHead\}>[\s\S]+?EasyWork/);
  assert.match(viewStyles, /\.assistantBody\s*\{[^}]*font-size:\s*17px;[^}]*line-height:\s*1\.72;/s);
  assert.match(timelineStyles, /\.webThoughtHeading\s*\{[^}]*grid-template-columns:22px minmax\(0,auto\) 14px;[^}]*gap:6px;[^}]*padding:2px 7px 2px 1px;/s);
  assert.match(timelineStyles, /\.agentCallHeading\s*\{[^}]*grid-template-columns:\s*22px auto 15px;[^}]*gap:\s*6px;[^}]*padding:\s*2px 6px 2px 1px;/s);
  assert.match(timelineStyles, /\.activityHeadingLabel\s*\{[^}]*font-size:var\(--timeline-heading-size\);[^}]*font-weight:400;[^}]*line-height:1\.45;/s);
  assert.match(timelineStyles, /\.webThoughtGlyph svg,\.agentCallGlyph svg\s*\{[^}]*width:17px;[^}]*height:17px;/s);
  assert.match(timelineStyles, /\.workflow\s*\{[^}]*gap:3px;[^}]*margin:\s*0 0 7px;/s);
  assert.match(viewStyles, /\.railToggle\s*\{[^}]*place-items:\s*center;[^}]*padding:\s*0;/s);
  assert.match(viewStyles, /\.railToggle\s*>\s*svg\s*\{[^}]*margin:\s*0 auto;[^}]*transform:\s*translateX\(-1px\);/s);
});

test("对话输入区不遮挡两侧内容，滚动条沿用透明细轨道", async () => {
  const [styles, controlStyles] = await Promise.all([
    readFile(viewStylePath, "utf8"),
    readFile(controlStylePath, "utf8"),
  ]);
  assert.match(styles, /\.composerWrap\s*\{[^}]*position:relative;[^}]*background:transparent;/s);
  assert.match(styles, /\.composerWrap::before\s*\{[^}]*pointer-events:none;[^}]*background:linear-gradient\(/s);
  assert.doesNotMatch(styles, /\.composerWrap::before\s*\{[^}]*(?:backdrop-filter|mask-image)/s);
  assert.match(styles, /\.messages\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*scrollbar-color:\s*rgb\(99 108 98 \/ 30%\) transparent;[^}]*scrollbar-width:\s*thin;/s);
  assert.match(styles, /\.messages::-webkit-scrollbar\s*\{[^}]*width:\s*9px;[^}]*height:\s*9px;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.messages::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*3px solid transparent;[^}]*border-radius:\s*999px;[^}]*background:\s*rgb\(99 108 98 \/ 30%\);[^}]*background-clip:\s*padding-box;/s);
  assert.match(styles, /\.messages::-webkit-scrollbar-track,\.messages::-webkit-scrollbar-corner\s*\{[^}]*background:\s*transparent;/s);
  assert.match(controlStyles, /\.rootList,\.configPanel,\.modelViewport\s*\{[^}]*scrollbar-color:rgb\(99 108 98 \/ 28%\) transparent;[^}]*scrollbar-width:thin;[^}]*scrollbar-gutter:stable;/s);
  assert.match(controlStyles, /\.rootList::-webkit-scrollbar,\.configPanel::-webkit-scrollbar,\.modelViewport::-webkit-scrollbar\s*\{[^}]*width:8px;[^}]*height:8px;[^}]*background:transparent;/s);
  assert.match(controlStyles, /\.rootList::-webkit-scrollbar-button,\.configPanel::-webkit-scrollbar-button,\.modelViewport::-webkit-scrollbar-button\s*\{[^}]*display:none;[^}]*width:0;[^}]*height:0;/s);
  assert.match(controlStyles, /\.rootList::-webkit-scrollbar-thumb,\.configPanel::-webkit-scrollbar-thumb,\.modelViewport::-webkit-scrollbar-thumb\s*\{[^}]*border:2px solid transparent;[^}]*border-radius:999px;[^}]*background:rgb\(99 108 98 \/ 28%\);[^}]*background-clip:padding-box;/s);
  assert.match(styles, /\.modelList\s*\{[^}]*scrollbar-color:rgb\(99 108 98 \/ 28%\) transparent;[^}]*scrollbar-width:thin;[^}]*scrollbar-gutter:stable;/s);
  assert.match(styles, /\.modelList::-webkit-scrollbar-button\s*\{[^}]*display:none;[^}]*width:0;[^}]*height:0;/s);
});

test("三种 Agent 的统一计划条与左侧菜单同字号，只有存在计划的对话记录可展开", async () => {
  const [view, viewStyles, timeline] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(viewStylePath, "utf8"),
    readFile(timelinePath, "utf8"),
  ]);
  assert.match(viewStyles, /\.rail\s*\{[^}]*--rail-font-size:13\.5px;[^}]*--rail-sub-font-size:12\.5px;[^}]*font-family:var\(--ew-font\);/s);
  assert.match(viewStyles, /\.railTitle,\.railConnectionHeading\s*\{[^}]*font-family:var\(--ew-font\);[^}]*font-size:var\(--rail-font-size\);/s);
  assert.match(viewStyles, /\.railWorkspaceValue\s*\{[^}]*font-size:var\(--rail-sub-font-size\);/s);
  assert.match(viewStyles, /\.railSub\s*\{[^}]*font-family:var\(--ew-font\);[^}]*font-size:var\(--rail-sub-font-size\);/s);
  assert.match(viewStyles, /\.record\s*\{[^}]*font-size:var\(--rail-font-size\);/s);
  assert.match(view, /function ComposerTaskPlan/);
  assert.match(view, /<TaskPlanList task=\{task\}/);
  assert.match(view, /hasPlan && task \? <DisclosureMotion open=\{expanded\} className=\{styles\.recordPlan\}/);
  assert.match(viewStyles, /\.composerPlan\s*\{[^}]*width:66\.666%;[^}]*font-size:var\(--rail-font-size,13\.5px\);/s);
  assert.doesNotMatch(view, /styles\.composerPlanExpanded/);
  assert.match(viewStyles, /\.composerPlanOpen \.composerPlanCurrent\s*\{[^}]*height:calc\(var\(--plan-count\)/s);
  assert.match(viewStyles, /\.taskPlanStep\s*\{[^}]*font-size:var\(--rail-font-size,13\.5px\);/s);
  assert.match(timeline, /event\.kind === "plan" \|\| event\.kind === "plan_state"/);
  assert.match(view, /const hasPlan = Boolean\(task && Array\.isArray\(task\.plan\) && task\.plan\.length > 0\);/);
  assert.match(view, /\{hasPlan \? <button className=\{styles\.recordExpand\}/);
  assert.doesNotMatch(view, /hasPlan && task && expanded \?/);
});

test("当前工作区保留完整路径，并从路径前端省略以优先显示末尾目录", async () => {
  const [view, viewStyles] = await Promise.all([readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8")]);
  assert.doesNotMatch(view, /compactWorkspacePath/);
  assert.match(view, /workbenchWorkspacePath \? <bdi dir="ltr">\{workbenchWorkspacePath\}<\/bdi>/);
  assert.match(viewStyles, /\.railValue\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/s);
  assert.match(viewStyles, /\.railWorkspaceValue\s*\{[^}]*direction:rtl;[^}]*text-align:left;/s);
  assert.match(viewStyles, /\.railWorkspaceValue > bdi\s*\{[^}]*direction:ltr;[^}]*unicode-bidi:isolate;/s);
  assert.match(viewStyles, /@media \(max-width: 719px\)[\s\S]+?\.rail\s*\{[^}]*width:calc\(100% - 40px\)/s);
});

test("对话最终内容原子交接，历史读取和滚动恢复不会随消息反复触发", async () => {
  const [view, timeline] = await Promise.all([readFile(viewPath, "utf8"), readFile(timelinePath, "utf8")]);
  assert.match(timeline, /segment\.committed && segment\.content && segment\.target === "final"/);
  assert.match(timeline, /const recoveredFinal = latestRunFailed && !committedFinals\.length/);
  assert.match(timeline, /latestStartedRunId/);
  assert.match(timeline, /streamingMessageId:/);
  assert.match(view, /streamingMessagePersisted/);
  assert.match(view, /visibleStreamingFinal/);
  assert.match(view, /followConversationScroll[\s\S]+?\[conversationId, initialPanel, loading\]/);
  assert.match(view, /mergeConversationEvents\(current, incoming\)/);
  assert.doesNotMatch(view, /!eventsHydrated \|\| !realtime/);
  assert.doesNotMatch(view, /\[conversationId, messages\.length\]/);
  assert.match(view, /if \(!conversationId \|\| loadedConversationId !== conversationId \|\| activeMode !== "work"\) return;/);
  assert.match(view, /retainConversationEvents\(current, nextMessages, conversationId, tasksRef\.current\)/);
  assert.match(timeline, /function latestRunEvents/);
});

test("失败 Task 没有助手正文时，追加提问仍保留上一轮 Agent 活动", () => {
  const conversationId = "conv-retain-failed-turn";
  const firstUser = { id: "message-first-user", role: "user", taskId: null, createdAt: "2026-08-22T07:55:56.000Z" };
  const secondUser = { id: "message-second-user", role: "user", taskId: null, createdAt: "2026-08-22T15:20:36.000Z" };
  const nextMessages = [firstUser, secondUser];
  const previousTaskEvent = {
    eventId: "event-previous-task-final",
    occurredAt: "2026-08-22T08:03:59.000Z",
    producer: "agent:claude-code",
    kind: "final",
    status: "completed",
    ids: { conversationId, runId: "run-previous", taskId: "task-previous" },
    payload: { text: "上一轮已产生的 Agent 回答" },
  };
  const previousFailure = {
    ...previousTaskEvent,
    eventId: "event-previous-failure",
    occurredAt: "2026-08-22T08:09:41.000Z",
    producer: "web-agent",
    kind: "run.failed",
    status: "failed",
    payload: { taskId: "task-previous", message: "版本文件超过大小上限" },
  };
  const retained = retainConversationEvents(
    [previousTaskEvent, previousFailure],
    nextMessages,
    conversationId,
    { "task-previous": { id: "task-previous", sourceMessageId: firstUser.id, conversationRunId: "run-previous" } },
  );
  assert.deepEqual(retained.map((event) => event.eventId), ["event-previous-task-final", "event-previous-failure"]);
});

test("已安装技能把名称、简介与绿色引用线收为同一行", async () => {
  const [markdown, styles] = await Promise.all([
    readFile(markdownPath, "utf8"),
    readFile(markdownStylePath, "utf8"),
  ]);
  assert.match(markdown, /function remarkInstalledSkillRows/);
  assert.match(markdown, /function standaloneStrongChildren/);
  assert.match(markdown, /node\.type !== "heading" && !standaloneStrongChildren\(node\)/);
  assert.match(markdown, /const nameChildren = skillNameChildren\(node, sectionDepth\)/);
  assert.match(markdown, /function skillSummaryInlineChildren/);
  assert.match(markdown, /if \(!text \|\| text === "\|"\) continue/);
  assert.match(markdown, /compactSkillSummaryRow\(node\)/);
  assert.match(markdown, /\{ type: "strong", children: nameChildren \}/);
  assert.match(markdown, /root\.children\.splice\(index, 2, row\)/);
  assert.match(markdown, /className: "skill-summary-row"/);
  assert.match(markdown, /remarkPlugins=\{\[remarkGfm, remarkMath, remarkPlainUrlBoundaries, remarkLooseStrongMarkers, remarkInstalledSkillRows,/);
  assert.match(markdown, /styles\.skillSummaryRow/);
  assert.match(styles, /\.skillSummaryRow\s*\{[^}]*border-left-color:\s*#9dbba4;[^}]*padding-top:\s*\.12em;[^}]*padding-bottom:\s*\.12em;[^}]*white-space:\s*normal;/s);
  assert.match(styles, /\.skillSummaryRow > p\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.skillSummaryRow > p > strong:first-child\s*\{[^}]*margin-right:\s*\.62em;[^}]*white-space:\s*nowrap;/s);
});

test("正文解析普通、带空格和被转义的粗体标记，且不改写代码内容", async () => {
  const [markdown, styles] = await Promise.all([readFile(markdownPath, "utf8"), readFile(markdownStylePath, "utf8")]);
  assert.match(markdown, /function looseStrongTextNodes/);
  assert.match(markdown, /marker === "__" && \(\/\\w\/\.test\(before\) \|\| \/\\w\/\.test\(after\)\)/);
  assert.match(markdown, /nodes\.push\(\{ type: "strong", children: \[\{ type: "text", value: content\.trim\(\) \}\] \}\)/);
  assert.match(markdown, /const opaqueNodes = new Set\(\["code", "inlineCode", "html", "math", "inlineMath"\]\)/);
  assert.match(markdown, /remarkPlugins=\{\[remarkGfm, remarkMath, remarkPlainUrlBoundaries, remarkLooseStrongMarkers, remarkInstalledSkillRows,/);
  assert.match(styles, /\.markdown\s*\{[^}]*font-family:\s*var\(--ew-font\);[^}]*font-size:\s*17px;/s);
  assert.match(styles, /\.markdown :where\(strong,b,em,i,a,del\)\s*\{[^}]*font-family:\s*inherit;[^}]*font-size:\s*inherit;/s);
  assert.match(styles, /\.markdown strong,\.markdown b\s*\{[^}]*font-weight:\s*700;/s);
  assert.match(styles, /\.inlineField\s*\{[^}]*background:\s*transparent;[^}]*font-family:\s*inherit;[^}]*font-size:\s*inherit;/s);
  assert.match(styles, /\.activityInline\s*\{[^}]*font-family:inherit;[^}]*font-size:inherit;/s);
});

test("代码块使用正文字体和小字号、保留暖背景并在块内横向滚动", async () => {
  const [markdown, styles] = await Promise.all([readFile(markdownPath, "utf8"), readFile(markdownStylePath, "utf8")]);
  assert.match(markdown, /function MarkdownCodeBlock/);
  assert.match(markdown, /type="range"[\s\S]+?aria-label="横向滚动代码"/);
  assert.match(markdown, /const blockRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(markdown, /block\.addEventListener\("wheel", handleWheel, \{ passive: false \}\)/);
  assert.match(markdown, /<div ref=\{blockRef\} className=\{`\$\{styles\.copyableCodeBlock\}/);
  assert.match(markdown, /const next = codeWheelPosition\(viewport, event, overScrollbar\);\s*if \(next === null\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*viewport\.scrollLeft = next;/);
  assert.match(styles, /\.copyableCodeBlock\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*background:\s*var\(--code-block-surface\);[^}]*margin:\s*0;/s);
  assert.match(styles, /\.remoteTerminal\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;[^}]*background:\s*transparent;[^}]*padding:\s*10px 14px;[^}]*font-family:\s*var\(--ew-font\);[^}]*font-size:\s*\.9em;[^}]*font-weight:\s*400;/s);
  assert.match(styles, /\.remoteTerminal code\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;[^}]*max-width:\s*none;[^}]*font-family:\s*inherit;[^}]*font-weight:\s*400;[^}]*padding-right:\s*44px;[^}]*white-space:\s*pre;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/s);
  assert.doesNotMatch(styles, /\.remoteTerminal\s*\{[^}]*background:\s*linear-gradient/s);
  assert.doesNotMatch(styles, /\.remoteTerminal code\s*\{[^}]*font-family:\s*var\(--ew-mono\)/s);
  assert.match(styles, /\.remoteTerminal::\-webkit-scrollbar\s*\{[^}]*height:0;/s);
  assert.match(styles, /\.codeScrollbar\s*\{[^}]*right:1px;[^}]*left:1px;[^}]*width:calc\(100% - 2px\);[^}]*height:10px;[^}]*opacity:0;[^}]*pointer-events:none;[^}]*cursor:default;/s);
  assert.doesNotMatch(styles, /cursor:ew-resize/);
  assert.match(styles, /\.codeScrollbar::\-webkit-slider-runnable-track\s*\{[^}]*height:3px;[^}]*background:transparent;/s);
  assert.match(styles, /\.copyableCodeBlock:hover \.codeScrollbar,\.codeScrollbar:focus-visible\s*\{[^}]*opacity:1;[^}]*pointer-events:auto;/s);
  assert.match(styles, /\.copyableCodeBlock > \.blockCopyButton\s*\{[^}]*z-index:6;[^}]*top:8px;[^}]*border:0;[^}]*background:transparent;/s);
});

test("Agent 调用中的操作、文件与阶段文本使用紧凑垂直节奏", async () => {
  const styles = await readFile(timelineStylePath, "utf8");
  assert.match(styles, /\.agentActivity\s*\{[^}]*gap:2px;[^}]*padding:1px 0 0 var\(--activity-content-inset\);/s);
  assert.match(styles, /\.groupHeading\s*\{[^}]*min-height:29px;[^}]*padding:2px 0;/s);
  assert.match(styles, /\.reasoningLabel\s*\{[^}]*font-size:var\(--timeline-title-size\);/s);
  assert.match(styles, /\.commandGroupHeading strong\s*\{[^}]*font-size:var\(--timeline-title-size\);[^}]*font-weight:400;/s);
  assert.match(styles, /\.commandList\s*\{[^}]*margin:0 7px 3px 11px;/s);
  assert.match(styles, /\.commandSummary,\.fileSummary\s*\{[^}]*min-height:28px;[^}]*padding:1px 0;/s);
  assert.match(styles, /\.agentThought\s*\{[^}]*padding:2px 0;/s);
});

test("任务级 Agent 失败直接显示单条错误消息，不再重复标题与展开层级", async () => {
  const [timeline, styles] = await Promise.all([readFile(timelinePath, "utf8"), readFile(timelineStylePath, "utf8")]);
  assert.match(timeline, /function agentFailureMessage[\s\S]+?failureEvents\.length - 1[\s\S]+?Agent 调用失败，请稍后重试/);
  assert.match(timeline, /function AgentFailureNotice[\s\S]+?className=\{styles\.agentFailureNotice\}[\s\S]+?role="alert"/);
  assert.match(timeline, /if \(failed\) return <AgentFailureNotice message=\{agentFailureMessage\(events, task, failure\)\} \/>/);
  assert.doesNotMatch(timeline, /failed \? "Agent调用失败"/);
  assert.doesNotMatch(timeline, /fallbackFailure \? <div className=\{styles\.agentCallFailure\}/);
  assert.match(styles, /\.agentFailureNotice\s*\{[^}]*width:min\(820px,100%\);[^}]*border-left:3px solid[^}]*border-radius:9px;[^}]*background:rgb\(161 60 50 \/ 5%\);/s);
});

test("纯文本网址在全角结束标点处终止，显式 Markdown 链接不被改写", async () => {
  const markdown = await readFile(markdownPath, "utf8");
  assert.match(markdown, /const PLAIN_URL_BOUNDARY = \/\[）】》」』〉〕］｝，。；：！？、\]\//);
  assert.match(markdown, /child\.type === "link"[\s\S]+?text === child\.url/);
  assert.match(markdown, /children\.push\(\{ \.\.\.child, url, children: \[\{ type: "text", value: url \}\] \}\)/);
  assert.match(markdown, /children\.push\(\{ type: "text", value: text\.slice\(boundary\) \}\)/);
});

test("远端与网页 Work Agent 的原有思考流正常展示，Work 自由文本终答仍不发布", async () => {
  const [timeline, styles, webAgentRuntime, runtime, platformStore] = await Promise.all([
    readFile(timelinePath, "utf8"),
    readFile(timelineStylePath, "utf8"),
    readFile(webAgentRuntimePath, "utf8"),
    readFile(runtimePath, "utf8"),
    readFile(platformStorePath, "utf8"),
  ]);
  assert.match(timeline, /function BackgroundTrace[\s\S]+?useTimelineDisclosure\(disclosureId, true\)/);
  assert.match(timeline, /function ReasoningTrace[\s\S]+?useTimelineDisclosure\(disclosureId, true\)/);
  assert.match(timeline, /entry\.text\.replace\(\/\\n\(\?:\[ \\t\]\*\\n\)\{2,\}\/[\s\S]+?<MarkdownContent content=\{content\} compact activity \/>/);
  assert.match(timeline, /className=\{styles\.reasoningGlyph\}><MessageCircle size=\{15\} \/>/);
  assert.match(timeline, /<span className=\{styles\.reasoningLabel\}>思考内容<\/span>/);
  assert.doesNotMatch(timeline, /"已展开"|"已收起"/);
  assert.doesNotMatch(timeline, /reasoningByIteration/);
  assert.match(timeline, /const discardedReasoningIterations = new Set<number>\(\)/);
  assert.match(timeline, /const payload = payloadRecord\(event\.payload\)[\s\S]+?payload\.discardedReasoningIterations/);
  assert.match(timeline, /if \(discardedReasoningIterations\.has\(iteration\)\) continue/);
  const protocol = await readFile(new URL("../shared/timeline-protocol.mjs", import.meta.url), "utf8");
  assert.match(protocol, /const WEB_AGENT_PROTOCOL_TOOLS = new Set\([\s\S]+?resource_search[\s\S]+?handoff_submit/);
  assert.match(protocol, /function webToolProtocolShape[\s\S]+?WEB_AGENT_PROTOCOL_TOOLS\.has/);
  assert.match(protocol, /function isWorkProtocolReasoning[\s\S]+?webToolProtocolShape\(JSON\.parse\(content\)\)/);
  assert.match(timeline, /if \(workMode && isWorkProtocolReasoning\(nextStream\)\) continue/);
  assert.match(timeline, /if \(previous\?\.type !== "reasoning"\)/);
  assert.doesNotMatch(timeline, /previous\?\.iteration !== iteration/);
  assert.match(timeline, /entries\.push\(reasoning\)/);
  assert.match(timeline, /function WebThought[\s\S]+?const hasBody = trace\.entries\.length > 0 \|\| Boolean\(handoff\)/);
  assert.match(timeline, /const \[open, toggleOpen\] = useTimelineDisclosure\(disclosureId, hasBody, trace\.thinking\)/);
  assert.match(timeline, /className=\{styles\.webThoughtHeading\}[\s\S]+?aria-expanded=\{hasBody \? open : undefined\}/);
  assert.match(timeline, /entry\.type === "reasoning"[\s\S]+?<ReasoningTrace key=\{entry\.id\} entry=\{entry\} disclosureId=/);
  assert.match(timeline, /if \(event\.kind === "run\.output\.delta"\)[\s\S]+?replacement[\s\S]+?type: "reasoning"/);
  assert.doesNotMatch(timeline, /className=\{styles\.activityText\}/);
  assert.match(timeline, /function AgentCall[\s\S]+?useTimelineDisclosure\(disclosureId, hasDetails, running && !collapseWhen/);
  assert.match(timeline, /trace\.thinking \? "正在思考"/);
  assert.match(timeline, /trace\.aborted \? "思考已停止" : "思考完成"/);
  assert.match(timeline, /rawAbortReason\.trim\(\) === "请求已停止" \? "" : rawAbortReason/);
  assert.match(timeline, /const showThought = !directRemoteAppend && \([\s\S]+?webTrace\.started[\s\S]+?webTrace\.running[\s\S]+?webTrace\.entries\.length > 0[\s\S]+?webTrace\.handoff[\s\S]+?webTrace\.failure \|\| webTrace\.abortReason/);
  assert.match(timeline, /className=\{styles\.webThoughtGlyph\}[\s\S]+?<Brain size=\{17\}/);
  assert.match(timeline, /className=\{styles\.activityHeadingLabel\}>\{label\}<\/span>[\s\S]+?styles\.webThoughtChevron/);
  assert.match(timeline, /className=\{styles\.handoffGlyph\}><Send size=\{15\} \/>/);
  assert.match(timeline, /<span className=\{styles\.handoffLabel\}>发给远端 Agent<\/span>/);
  assert.match(timeline, /function WorkHandoff[\s\S]+?useTimelineDisclosure\(disclosureId, true\)[\s\S]+?styles\.handoffMotion/);
  assert.match(timeline, /<WebThought events=\{events\} handoff=\{showHandoff \? webTrace\.handoff : null\} \/>/);
  assert.doesNotMatch(timeline, /!showThought && showHandoff \? <WorkHandoff/);
  assert.doesNotMatch(timeline, /思考未完成|trace\.activeLabel/);
  assert.match(timeline, /trace\.entries\.map/);
  assert.doesNotMatch(timeline, /function currentStateResults|function searchResults/);
  assert.doesNotMatch(timeline, /\$\{sourceLabel\(source\)\}结果/);
  assert.match(webAgentRuntime, /delta\.kind === "reasoning" && delta\.content[\s\S]+?await emit\("run\.reasoning\.delta"/);
  assert.doesNotMatch(webAgentRuntime, /mode === "work" \? \{ provisional: true \} : \{\}/);
  assert.doesNotMatch(webAgentRuntime, /mode === "work" && nextContent && result\.toolCalls\.length[\s\S]+?source: "content"/);
  assert.match(webAgentRuntime, /const onlySubmitAvailable = mode === "work"[\s\S]+?availableTools\[0\]\.name === "handoff_submit"/);
  assert.match(webAgentRuntime, /mode === "work" \? \{ toolChoice: onlySubmitAvailable \? "handoff_submit" : "required" \} : \{\}/);
  assert.match(webAgentRuntime, /let submittedCandidateIds = null[\s\S]+?submittedCandidateIds = input\.candidateIds[\s\S]+?return completeWork\(iteration \+ 1, submittedCandidateIds\)/);
  assert.match(webAgentRuntime, /tool\.timelineRead && rendered[\s\S]+?emit\("run\.context\.read"/);
  assert.doesNotMatch(webAgentRuntime, /run\.tool\.(?:started|completed|failed)/);
  const motionStyles = await readFile(new URL("../app/easywork/features/conversation/DisclosureMotion.module.css", import.meta.url), "utf8");
  assert.match(motionStyles, /\.motion\s*\{[^}]*grid-template-rows:0fr;[^}]*transition:grid-template-rows/s);
  assert.match(motionStyles, /\.motion\[data-expanded="true"\]\s*\{[^}]*grid-template-rows:1fr;/s);
  assert.match(timeline, /<DisclosureMotion open=\{open\} ready=\{detailState\.ready\} className=\{styles\.reasoningMotion\}/);
  assert.match(timeline, /<DisclosureMotion open=\{hasBody && open\} className=\{styles\.webThoughtMotion\}/);
  assert.match(styles, /\.webThoughtOpen \.webThoughtChevron[^}]*rotate\(90deg\)/s);
  assert.match(styles, /\.reasoningHeading\s*\{[^}]*grid-template-columns:22px minmax\(0,auto\) 14px;/s);
  assert.match(styles, /\.backgroundHeading\s*\{[^}]*align-items:center;/s);
  assert.match(styles, /\.backgroundChevron\s*\{[^}]*rotate\(0deg\)/s);
  assert.match(styles, /\.reasoningText\s*\{[^}]*padding:4px 10px 4px 0;[^}]*font-size:var\(--timeline-detail-size\);[^}]*line-height:var\(--timeline-body-leading\);/s);
  assert.doesNotMatch(styles, /\.activityText/);
  assert.match(styles, /\.agentThoughtContent[^}]*font-size:var\(--timeline-body-size\);[^}]*line-height:var\(--timeline-body-leading\);/s);
  assert.match(styles, /\.commandSummary code[^}]*font-size:var\(--timeline-code-size\);/s);
  assert.match(styles, /\.fileCopy strong[^}]*font-size:var\(--timeline-code-size\);/s);
  assert.match(styles, /\.remoteTerminal code[^}]*font-size:var\(--timeline-code-size\);/s);
  assert.match(styles, /\.diffLine code[^}]*font-size:var\(--timeline-code-size\);/s);
  assert.match(styles, /\.webThoughtBody[^}]*gap:\s*5px;[^}]*margin:3px 0 0 11px;[^}]*border-left:1px solid[^}]*padding:2px 0 2px 16px;/s);
  assert.match(styles, /\.backgroundTrace\s*\{[^}]*background:transparent;/s);
  assert.match(styles, /\.handoffHeading\s*\{[^}]*color:#827a6e;/s);
  assert.match(styles, /\.handoffGlyph\s*\{[^}]*color:inherit;[^}]*\}\.handoffLabel\s*\{[^}]*color:inherit;/s);
  assert.match(runtime, /#recordModelUsage[^;]+\.catch\(\(\) => undefined\);/);
  assert.match(platformStore, /replaceFileWithRetry\(temporaryPath, filePath\)/);
});

test("Modal 仅在打开时设置一次焦点，受控输入重渲染不会把焦点抢回关闭按钮", async () => {
  const modal = await readFile(modalPath, "utf8");
  assert.match(modal, /const onCloseRef = useRef\(onClose\)/);
  assert.match(modal, /panel\?\.querySelector<HTMLElement>\("\[autofocus\]"\)/);
});

test("Agent 上下文、切换和运行控制只按真实 capability 启用", async () => {
  const [view, control, services, webTools] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(controlPath, "utf8"),
    readFile(servicesPath, "utf8"),
    readFile(webToolsPath, "utf8"),
  ]);
  assert.match(control, /runtimeCapabilities\?\.\[operation\]\?\.availability === "available"/);
  assert.match(control, /Agent 未返回可验证的上下文用量/);
  assert.match(control, /上限未知/);
  assert.match(control, /bindingIdsByAgent\?\.\[contextAgent\.agentId\]/);
  assert.match(view, /bindingIdsByAgent=\{bindingIdsByAgent\}/);
  const historyHydration = view.slice(view.indexOf("const hydrateTaskHistory"), view.indexOf("const fetchConversation"));
  assert.match(historyHydration, /setTasks\(\(current\) => \(\{ \.\.\.current, \.\.\.listedTasks \}\)\)/);
  assert.doesNotMatch(historyHydration, /replayCompleteTaskHistory|Promise\.allSettled/);
  assert.match(control, /\/context\?\$\{query\}/);
  assert.match(control, /\/compact/);
  assert.doesNotMatch(control, /可修改：/);
  assert.match(control, /type="text" inputMode="numeric"/);
  assert.match(control, /setConfigMutationError\(message\)/);
  assert.match(control, /configMutationError \? <p className=\{styles\.operationError\}/);
  assert.match(view, /workspace-switch\/describe/);
  assert.match(view, /nextAgentId === routedAgentId/);
  assert.doesNotMatch(view, /nextAgentId === agentId\) return/);
  assert.match(view, /agentOperationAvailable\(selectedAgent, "append"\)/);
  assert.match(view, /agentOperationAvailable\(selectedAgent, "interrupt"\)/);
  assert.match(view, /directRemoteTaskId: activeTask\.id/);
  assert.doesNotMatch(view, /waitForOpenCodeQueueWindow|queueOpenCode|queueWhileRunning/);
  assert.match(view, /mergeTaskSnapshots/);
  assert.match(view, /isActiveTask/);
  assert.doesNotMatch(view, /\/api\/tasks\/\$\{activeTask\.id\}\/append/);
  assert.doesNotMatch(view, /\/api\/tasks\/\$\{activeTask\.id\}\/resume/);
  assert.match(services, /class RemoteTaskLifecycle/);
  assert.match(services, /operation: "create"/);
  assert.match(services, /operation: "append"/);
  assert.doesNotMatch(services, /current\.status === "interrupted"[\s\S]+?orchestrator\.resume\(current\.id/);
  assert.doesNotMatch(webTools, /name: "task_(?:create|observe|append|interrupt|resume)"/);
});

test("Agent 中断后新消息新建 Task，运行中追加才直通并复用原生会话", async () => {
  const [view, viewStyles, services, timeline] = await Promise.all([readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8"), readFile(servicesPath, "utf8"), readFile(timelinePath, "utf8")]);
  assert.match(view, /directRemoteTaskId: activeTask\.id/);
  assert.match(view, /mergeTaskSnapshots/);
  assert.match(view, /isActiveTask/);
  assert.match(services, /const skipWebAgentModel = mode === "work" && !taskId && Boolean\(directRemoteTask\)/);
  assert.match(services, /const agentBindingId = createAgentBindingKey\(taskScope, scope\.agentId\)/);
  assert.doesNotMatch(services, /statuses: \[[^\]]*"interrupted"[^\]]*\][\s\S]{0,500}const matching = candidates/);
  assert.doesNotMatch(services, /current\.status === "interrupted"[\s\S]+?orchestrator\.resume\(current\.id/);
  assert.match(services, /const prompt = String\(userMessage \|\| ""\)/);
  assert.doesNotMatch(services, /OPENCODE_QUEUED_TURN_SETTLED_STATUSES|waitForOpenCodeQueueWindow|OPENCODE_APPEND_QUEUE_TIMEOUT/);
  assert.match(services, /directRemoteTask: true/);
  assert.match(timeline, /export function isDirectRemoteAppendTimeline/);
  assert.match(timeline, /const directRemoteAppend = useMemo\(\(\) => isDirectRemoteAppendTimeline\(events\)/);
  assert.match(timeline, /payloadRecord\(event\.payload\)\.operation === "append"/);
  assert.match(timeline, /const showThought = !directRemoteAppend/);
  assert.match(timeline, /const showHandoff = mode === "work" && !directRemoteAppend/);
  assert.match(view, /const directRemoteAppend = !user && isDirectRemoteAppendTimeline\(timelineEvents \|\| \[\]\)/);
  assert.match(view, /orphanTimelineByUserMessage[\s\S]+?isDirectRemoteAppendTimeline\(orphanTimelineByUserMessage\.get\(message\.id\) \|\| \[\]\) \? null/);
  assert.match(view, /const directRemoteAppendUserMessageIds = new Set/);
  assert.match(view, /beforeDirectRemoteAppendTurn \? styles\.beforeDirectRemoteAppendTurn/);
  assert.match(view, /directRemoteAppendTurn \? styles\.directRemoteAppendTurn/);
  assert.match(viewStyles, /\.beforeDirectRemoteAppendTurn > \.assistant\s*\{[^}]*margin-bottom:14px;[^}]*padding-bottom:12px;[^}]*border-bottom:0;/s);
  assert.match(viewStyles, /\.directRemoteAppendTurn > \.user\s*\{[^}]*margin-bottom:14px;/s);
  assert.match(copySource, /if \(taskId && event\.ids\.taskId\)[\s\S]+?event\.ids\.taskId === taskId && event\.ids\.sourceMessageId === sourceId/);
  assert.match(copySource, /!runId \|\| !event\.ids\.runId \|\| event\.ids\.runId === runId/);
  assert.doesNotMatch(view, /compareTimelinePosition|nextRunStart/);
});

test("新建 Work 的 Agent 状态、模型路由与权限菜单保持当前交互", async () => {
  const [view, control, controlStyles, runtime] = await Promise.all([readFile(viewPath, "utf8"), readFile(controlPath, "utf8"), readFile(controlStylePath, "utf8"), readFile(runtimePath, "utf8")]);
  assert.match(view, /selectedServer \? selectedServer\.name : "连接远程服务器"/);
  assert.match(view, /selectedAgent\.displayName[^\n]+selectedAgent\.model/);
  assert.match(view, /selectedAgent\.configured/);
  assert.match(control, /正在安装 \$\{installingAgent\.displayName\}/);
  assert.match(control, /easywork\.agent-provider:/);
  assert.match(control, /easywork\.agent-model:/);
  assert.match(control, /需要配置api/);
  assert.match(control, /EasyWork已部署/);
  assert.match(control, /未部署/);
  assert.match(control, /ready \? <span className=\{styles\.rowActions\}>/);
  assert.match(control, /打开配置/);
  assert.match(control, /configAgent && \["opencode", "codex", "claude-code"\]\.includes\(configAgent\.agentId\) && onConfigure/);
  assert.match(view, /import \{ AgentConfigDialog \} from "\.\/AgentConfigDialog"/);
  assert.match(view, /onConfigure=\{\(agent\) => setAgentConfigAgentId\(agent\.agentId\)\}/);
  assert.match(view, /agentConfigAgent\.agentId !== "qoder-cn"[\s\S]+?<AgentConfigDialog/);
  assert.match(control, /\{configAgent && \["opencode", "codex", "claude-code", "qoder-cn"\]\.includes/);
  assert.doesNotMatch(control, /"EasyWork 部署"|"用户部署"|"未安装"/);
  assert.doesNotMatch(control, /<option value="">未设置<\/option>/);
  assert.match(runtime, /refreshManagedConfiguration\(request\.params\.agentId\)/);
  assert.match(control, /const needsLogin = agent\.authentication\?\.required === true && !agent\.authentication\.authenticated/);
  assert.match(control, /onLogin\(agent\.agentId\)/);
  assert.match(view, /agents\/\$\{encodeURIComponent\(targetAgentId\)\}\/login/);
  assert.match(view, /window\.open\("about:blank", "_blank"\)/);
  assert.match(view, /请先登录 Qoder CN/);
  assert.match(view, /selectedAgent\.authentication\.authenticated/);
  assert.match(control, /agents\/qoder-cn\/catalog/);
  assert.match(control, /priceFactor/);
  assert.match(control, /当前积分/);
  assert.match(control, /qoderUsage\?\.orgResourcePackage\?\.available === true/);
  assert.match(control, /const \[qoderModels, setQoderModels\]/);
  assert.match(control, /qoderModels\.find\(\(model\) => model\.id === \(configuredModelId \|\| "auto"\)\)\?\.name/);
  assert.match(control, /easywork\.qoder-catalog:v1:/);
  assert.match(control, /modelsBusy && !visibleModels\.length/);
  assert.doesNotMatch(control, /qoderUsageBusy \? "正在读取模型"/);
  assert.doesNotMatch(control, /Code2/);
  assert.match(control, /isQoderConfig && !qoderAuthenticated/);
  assert.match(control, /disabled=\{loggingIn \|\| disabled \|\| Boolean\(selectingAgentId\)\}/);
  assert.ok(controlStyles.indexOf(".rootRow:has(.loginAction) .rootSelect { padding-right:106px; }") > controlStyles.indexOf(".rootRow:has(.rowActions) .rootSelect { padding-right:66px; }"));
  assert.ok(controlStyles.lastIndexOf(".rootRow:has(.loginAction) .rootSelect { padding-right:106px; }") > controlStyles.lastIndexOf(".rootRow:has(.rowActions) .rootSelect { padding-right:84px; }"));
  assert.match(view, /triggerVariant="setup"[\s\S]+?initialPage="root"/);
  assert.match(control, /const completeSetupConfig = async \(agent: AgentSummary\)/);
  assert.match(control, /triggerVariant === "setup" \? <button className=\{styles\.complete\}/);
  assert.match(control, /await onSelect\(agent\.agentId\)[\s\S]+?setOpen\(false\)[\s\S]+?setPage\("root"\)/);
  assert.match(control, /configBusy \|\| configSaving \|\| Boolean\(selectingAgentId\) \|\| disabled/);
  assert.match(controlStyles, /\.complete\s*\{/);
});

test("Work 绑定和 Agent 上下文不随每条运行事件反复重载", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /bootstrapServerIdKey/);
  assert.match(view, /selectedBindingTask\.completedAt \? selectedBindingTask\.revision : 1/);
  const bindingEffect = view.slice(view.indexOf("setServerBindingLoading(true)"), view.indexOf("const branchId = detail?.summary.activeBranchId"));
  assert.match(bindingEffect, /bootstrapServerIdKey/);
  assert.doesNotMatch(bindingEffect, /runtime\.bootstrap\?\.servers/);
  assert.match(view, /const conversationViewCache = new Map/);
  assert.match(view, /useState\(Boolean\(conversationId && !initialConversationCache\)\)/);
  assert.match(view, /const serverSetupCache = new Map/);
  assert.match(view, /if \(cached\)[\s\S]+?setSetupLoading\(false\)/);
  assert.match(view, /\.filter\(\(task\) => task\.route\?\.agentId === routedAgentId\)/);
  const selectedBindingSource = view.slice(view.indexOf("const selectedBindingTask"), view.indexOf("const selectedAgentBindingId"));
  assert.doesNotMatch(selectedBindingSource, /task\.route\?\.workspaceId === routedWorkspaceId/);
  const setupEffect = view.slice(view.indexOf("const cached = currentServerCacheKey"), view.indexOf("if (!conversationId || loadedConversationId !== conversationId || activeMode !== \"work\")"));
  assert.doesNotMatch(setupEffect, /refreshBootstrap/);
});

test("已持久化的 Agent 在扫描期间保持名称并显示加载态", async () => {
  const [view, control] = await Promise.all([readFile(viewPath, "utf8"), readFile(controlPath, "utf8")]);
  assert.match(view, /AGENT_LABELS: Record<string, string>/);
  assert.match(view, /triggerLabel=\{!selectedAgent && routedAgentId \? AGENT_LABELS\[routedAgentId\]/);
  assert.match(view, /loading=\{setupLoading && !selectedAgent\}/);
  assert.match(control, /loading \? <LoaderCircle className=\{styles\.spin\}/);
});

test("SSH 重连按连接代次重扫 Agent，失败时保留清单并显示原因与重试", async () => {
  const [view, control, cache, entities, services] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(controlPath, "utf8"),
    readFile(new URL("../app/easywork/features/conversation/agent-configuration-cache.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/core/contracts/entities.ts", import.meta.url), "utf8"),
    readFile(servicesPath, "utf8"),
  ]);
  assert.match(entities, /connectionGeneration\?: number/);
  assert.match(services, /connectionGeneration: Number\(connection\.generation \|\| 0\)/);
  assert.match(view, /cached\.connectionGeneration === connectionGeneration/);
  assert.match(view, /selectedServer\?\.connectionGeneration/);
  assert.match(view, /const readSetup = async <T,>\(path: string, label: string, timeoutMs = 6_000\)/);
  assert.match(view, /"Agent 列表读取", 30_000\)/);
  assert.match(view, /const cachedAgents = cached/);
  assert.match(view, /: cachedAgents/);
  assert.match(view, /: cachedWorkspaces/);
  assert.match(view, /Promise\.allSettled/);
  assert.match(view, /setAgentLoadError/);
  assert.match(view, /setWorkspaceLoadError/);
  assert.match(view, /loadError=\{agentLoadError \|\| capabilityError\}/);
  assert.match(view, /onRetry=\{\(\) => setSetupRetryRevision/);
  assert.match(control, /Agent 列表读取失败/);
  assert.match(control, /未读取到 Agent/);
  assert.match(control, /正在读取 Agent/);
  assert.match(cache, /agent\.configuration\.configScope !== configScope/);
  assert.match(cache, /configuration: null, model: null, configured: qoderReady/);
  assert.match(cache, /agent\.authentication\?\.authenticated === true/);
});

test("侧栏固定头尾、中部整体滚动，并按需加载八条聊天与项目对话", async () => {
  const [shell, styles, services] = await Promise.all([readFile(shellPath, "utf8"), readFile(shellStylePath, "utf8"), readFile(servicesPath, "utf8")]);
  const conversationSection = shell.slice(shell.indexOf("const conversationAction"), shell.indexOf("const renameProject"));
  const projectDeleteSection = shell.slice(shell.indexOf("const deleteProject"), shell.indexOf("const renderConversation"));
  const scrollingTitle = shell.slice(shell.indexOf("function ScrollingTitle"), shell.indexOf("export function AppShell"));
  assert.doesNotMatch(conversationSection, /window\.(?:prompt|confirm)/);
  assert.doesNotMatch(projectDeleteSection, /window\.confirm/);
  assert.match(projectDeleteSection, /conversationPolicy=delete/);
  assert.match(projectDeleteSection, /pending\.projectOnlyCommandId/);
  assert.match(projectDeleteSection, /pending\.withConversationsCommandId/);
  assert.match(shell, /<Modal title="删除项目？"/);
  assert.match(shell, /仅删除项目/);
  assert.match(shell, /删除项目及所有对话/);
  assert.match(shell, /projectOnlyCommandId: commandId\("project-delete"\)/);
  assert.match(shell, /withConversationsCommandId: commandId\("project-delete-with-conversations"\)/);
  assert.match(styles, /\.deleteDialog\s*\{/);
  assert.match(styles, /\.projectDeleteOptions\s*\{/);
  assert.match(styles, /\.projectDeleteOptionDanger\s*\{/);
  assert.doesNotMatch(scrollingTitle, /title=\{title\}/);
  assert.match(styles, /\.titleViewport\s*>\s*span\s*\{[^}]*width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(styles, /--sidebar-menu-font-size:\s*13\.5px;/);
  assert.match(styles, /--sidebar-menu-font-weight:\s*430;/);
  assert.match(styles, /\.sectionHeading\s*\{[^}]*font-size:\s*var\(--sidebar-menu-font-size\);[^}]*font-weight:\s*var\(--sidebar-menu-font-weight\);/s);
  assert.match(styles, /\.titleViewport\s*>\s*span\s*\{[^}]*font:\s*inherit;[^}]*font-size:\s*inherit;[^}]*font-weight:\s*inherit;/s);
  assert.doesNotMatch(styles, /\.treeItem\.nested \.titleViewport\s*>\s*span/);
  assert.match(styles, /\.conversationRow:hover \.titleScrollable\s*>\s*span[^\{]*\{[^}]*width:\s*max-content;[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;/s);
  assert.match(shell, /className=\{styles\.renameInput\}/);
  assert.match(shell, /<Modal title="删除对话？"/);
  assert.match(shell, /const latest = await runtime\.api\.get<\{ summary: ConversationSummary \}>/);
  assert.match(shell, /expectedRevision: latest\.data\.summary\.revision/);
  const optimisticDelete = shell.slice(shell.indexOf("const deleteConversation"), shell.indexOf("const renameProject"));
  const visibleCompletion = optimisticDelete.indexOf('kind: "deleted", optimistic: true');
  const backgroundRead = optimisticDelete.indexOf("const latest = await runtime.api.get");
  assert.ok(visibleCompletion >= 0 && backgroundRead > visibleCompletion, "前端应先移除对话，再开始后台删除");
  assert.match(optimisticDelete, /setConversationPendingDelete\(null\)[\s\S]+?optimistic: true[\s\S]+?runtime\.navigate[\s\S]+?runtime\.notify\("对话已删除"/);
  assert.match(optimisticDelete, /kind: "created", conversation: restoreConversation, optimistic: true/);
  assert.match(optimisticDelete, /对话删除失败，已恢复/);
  assert.doesNotMatch(optimisticDelete, /setDeletingConversation|await runtime\.refreshBootstrap/);
  assert.equal(optimisticDelete.match(/kind: "deleted"/g)?.length, 1, "后台成功后不应再触发全局前端刷新");
  assert.match(shell, /menuFixedActions[\s\S]+?menuSeparator[\s\S]+?projectDestinationList/);
  assert.match(shell, /length > 4 \? styles\.projectDestinationScrollable/);
  assert.match(styles, /\.projectDestinationScrollable\s*\{[^}]*max-height:\s*150px;[^}]*overflow-y:\s*auto;/s);
  assert.match(shell, /fixedNav[\s\S]+?新对话[\s\S]+?navScroll[\s\S]+?primaryNav[\s\S]+?文件库/);
  const fixedArea = shell.slice(shell.indexOf("<nav className={styles.fixedNav}"), shell.indexOf("<div className={styles.navScroll}>"));
  assert.match(fixedArea, /新对话[\s\S]+?searchOpen[\s\S]+?searchBox/);
  assert.doesNotMatch(shell.slice(shell.indexOf("<div className={styles.navScroll}>"), shell.indexOf("<nav className={styles.primaryNav}")), /searchBox/);
  assert.match(shell, /const displayedProjects = showAllProjects \|\| normalizedQuery \? visibleProjects : visibleProjects\.filter\(\(project, index\) => index < 4 \|\| project\.id === activeProjectId\)/);
  assert.match(shell, /visibleProjects\.length > 4[\s\S]+?showAllProjects \? "收起" : "显示更多"/);
  assert.match(shell, /const INITIAL_CHAT_LIMIT = 8/);
  assert.match(shell, /conversations\.slice\(0, INITIAL_CHAT_LIMIT\)/);
  assert.match(shell, /unassigned: "true", limit: "100", cursor/);
  assert.match(shell, /loadingAllChats \? "正在加载" : showAllChats \? "收起" : "更多"/);
  assert.match(shell, /const INITIAL_PROJECT_CHAT_LIMIT = 4/);
  assert.match(shell, /const displayed = showAll \? projectConversations : projectConversations\.filter\(\(item, index\) => index < INITIAL_PROJECT_CHAT_LIMIT \|\| item\.id === activeConversationId\)/);
  assert.match(shell, /if \(!expanded && !projectPage\?\.loaded\) void loadProjectConversations\(project\.id\)/);
  assert.match(shell, /new URLSearchParams\(\{[\s\S]+?projectId,[\s\S]+?INITIAL_PROJECT_CHAT_LIMIT/);
  assert.match(services, /bootstrapOverview\(\{ limit: 8, projectId: null,[^\n]*activeConversationId: conversationId/);
  assert.match(services, /listConversations\(\{ limit: 8, projectId: null \}\)/);
  assert.match(styles, /\.navScroll\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.fixedNav\s*\{[^}]*flex:\s*0 0 auto;[^}]*gap:\s*1px;[^}]*padding:\s*1px 10px 0;/s);
  assert.match(styles, /\.searchBox\s*\{[^}]*min-height:\s*36px;[^}]*gap:\s*7px;[^}]*font-size:\s*var\(--sidebar-menu-font-size\);[^}]*font-weight:\s*var\(--sidebar-menu-font-weight\);/s);
});

test("全站按钮与加载图标不触发文本光标、绿色焦点框或忙碌鼠标", async () => {
  const [base, viewStyles, accountStyles, serverStyles, projectStyles] = await Promise.all([
    readFile(baseStylePath, "utf8"),
    readFile(viewStylePath, "utf8"),
    readFile(new URL("../app/easywork/shell/AccountDialog.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/easywork/features/servers/ServerManager.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/easywork/features/projects/ProjectPage.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(base, /:where\(button,\[role="button"\],summary\)\s*\{[^}]*user-select:\s*none;[^}]*caret-color:\s*transparent;/s);
  assert.match(base, /:where\(button,\[role="button"\],summary\):focus-visible\s*\{[^}]*outline:\s*none;/s);
  assert.match(base, /:where\(button,\[role="button"\],summary\) svg\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(viewStyles, /\.view button:disabled[^}]*cursor:default;/s);
  for (const styles of [viewStyles, accountStyles, serverStyles, projectStyles]) assert.doesNotMatch(styles, /cursor\s*:\s*(?:wait|progress)/);
});

test("Agent 模型菜单在读取前后保持高度并铺满可滚动区域，配置中状态位于当前流程操作按钮左侧", async () => {
  const [control, styles] = await Promise.all([readFile(controlPath, "utf8"), readFile(controlStylePath, "utf8")]);
  assert.match(control, /const visibleModels = isQoderConfig \|\| providerId \? models : providers/);
  assert.match(control, /const modelMenuHeight = 360/);
  assert.match(control, /const selectedModelId = isQoderConfig[\s\S]+?resolvedConfig\?\.values\.model \|\| "auto"/);
  assert.match(control, /selectedModelId === "auto" \? "Auto" : selectedModelId/);
  assert.match(control, /className=\{selectedModelId === item\.id \? styles\.modelSelected : ""\}/);
  assert.match(styles, /\.modelPanel\s*\{[^}]*display:flex;[^}]*flex-direction:column;[^}]*overflow:hidden;/s);
  assert.match(control, /<div className=\{styles\.modelViewport\}>\{modelsBusy/);
  assert.match(styles, /\.modelViewport\s*\{[^}]*min-height:0;[^}]*flex:1 1 auto;[^}]*overflow-x:hidden;[^}]*overflow-y:auto;/s);
  assert.match(styles, /\.modelList\s*\{[^}]*min-height:100%;[^}]*align-content:start;/s);
  assert.match(styles, /\.modelViewport > \.menuState\s*\{[^}]*min-height:100%;/s);
  assert.match(control, /setConfigSaving\(true\)[\s\S]+?setConfigSaving\(false\)/);
  assert.match(control, /void onAgentsChanged\?\.\(\)\.catch\(\(\) => undefined\)/);
  assert.match(control, /const chooseModel = \(item: ModelSummary\)/);
  assert.match(control, /item\.defaultContextWindow \|\| supportedWindows\[0\][\s\S]+?values\.contextLimit/);
  assert.match(control, /className=\{`\$\{styles\.configFooter\} \$\{triggerVariant === "setup" \? "" : styles\.uninstallFooter\}`\}>\{configSaving \? <span className=\{styles\.runtimeConfiguring\}>[\s\S]+?配置中[\s\S]+?triggerVariant === "setup"[\s\S]+?className=\{styles\.complete\}[\s\S]+?className=\{styles\.uninstall\}/);
  assert.match(styles, /\.runtimeConfiguring\s*\{/);
  assert.match(styles, /\.uninstallFooter\s*\{[^}]*border-top:/s);
  assert.doesNotMatch(styles, /\.contextControls\s*\{[^}]*border-top:/s);
  assert.doesNotMatch(styles, /\.qoderCredits\s*\{[^}]*border-top:/s);
  assert.ok(control.indexOf("className={styles.qoderCredits}") < control.indexOf("styles.uninstallFooter"), "Qoder 积分应位于最底部卸载区上方");
});

test("Agent 配置 revision 冲突时刷新当前对话配置并只重放一次用户修改", async () => {
  const control = await readFile("app/easywork/features/conversation/AgentControl.tsx", "utf8");
  const dialog = await readFile("app/easywork/features/conversation/AgentConfigDialog.tsx", "utf8");
  for (const source of [control, dialog]) {
    assert.match(source, /errorCode\(reason\) !== "REVISION_CONFLICT"/);
    assert.match(source, /runtime\.api\.get<AgentConfiguration>/);
    assert.match(source, /alreadyApplied[\s\S]+?patchConfiguration\(latest, "agent-config-retry"\)/);
  }
});

test("模型拒绝思考档位后只显示一次 Agent 配置提示并同步实际档位", async () => {
  const [view, timeline, control, cache] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(timelinePath, "utf8"),
    readFile(controlPath, "utf8"),
    readFile(configurationCachePath, "utf8"),
  ]);
  assert.match(timeline, /agent_effort_adjusted: "思考强度已调整"/);
  assert.match(timeline, /\["unmapped_agent_event", "agent_compatibility_issue", "agent_effort_adjusted"\]\.includes\(operation\)/);
  const visibleRemoteEvent = timeline.slice(timeline.indexOf("function visibleRemoteEvent"), timeline.indexOf("function eventTaskId"));
  assert.match(visibleRemoteEvent, /event\.kind === "job_status"[\s\S]+?agent_effort_adjusted[\s\S]+?\.includes\(operation\)/);
  assert.doesNotMatch(visibleRemoteEvent, /if \(event\.kind === "job_status"\) return false/);
  assert.match(view, /event\.kind === "job_status" && payload\.operation === "agent_effort_adjusted" && payload\.configuration/);
  assert.match(view, /writeAgentConfigurationCache\(actorId, serverId, configScope, latestEffortConfiguration\)/);
  assert.match(view, /currentRevision > nextRevision/);
  assert.match(control, /candidateConfiguration\.configScope === cacheScope/);
  assert.match(control, /incomingConfigRevision > currentConfigRevision/);
  assert.match(control, /\? incomingConfiguration : config/);
  assert.match(cache, /existingRevision > nextRevision/);
  assert.match(cache, /remoteRevision > cachedRevision/);
});

test("工作台入口恢复到 Agent 配置按钮左侧并复用相同按钮规格", async () => {
  const [view, viewStyles, controlStyles] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(viewStylePath, "utf8"),
    readFile(controlStylePath, "utf8"),
  ]);
  assert.match(view, /const WorkbenchDrawer = lazy\(\(\) => import\("\.\.\/workbench\/WorkbenchDrawer"\)\)/);
  assert.match(view, /const \[workbenchOpen, setWorkbenchOpen\] = useState\(false\)/);
  assert.match(view, /const workbenchAvailable = Boolean\(serverCapabilities/);
  const header = view.slice(view.indexOf("<span className={styles.headerSpacer}"), view.indexOf("</header>"));
  assert.ok(header.indexOf("styles.workbenchButton") < header.indexOf("<AgentControl"));
  assert.match(header, /styles\.workbenchButton[\s\S]+?window\.innerWidth <= 719 \? !current : true[\s\S]+?<SquareTerminal size=\{15\} \/><span>工作台/);
  assert.match(view, /workbenchOpen && workbenchReady[\s\S]+?<WorkbenchDrawer[\s\S]+?onClose=\{\(\) => setWorkbenchOpen\(false\)\}/);
  const workbenchRule = viewStyles.match(/\.workbenchButton\s*\{[^}]*\}/s)?.[0] || "";
  const agentRule = controlStyles.match(/\.trigger\s*\{[^}]*\}/s)?.[0] || "";
  for (const declaration of ["height:38px", "gap:7px", "padding:0 10px", "border-radius:10px", "font-size:13px"]) {
    assert.match(workbenchRule, new RegExp(declaration));
    assert.match(agentRule, new RegExp(declaration));
  }
  assert.match(viewStyles, /\.modePill\s*\{[^}]*height:38px;[^}]*background:#fffdf8;/s);
  assert.match(workbenchRule, /background:#fffdf8/);
  assert.match(agentRule, /background:#fffdf8/);
  assert.match(viewStyles, /\.workbenchButton:disabled\s*\{[^}]*background:#f1efe9;[^}]*opacity:1;/s);
  assert.match(controlStyles, /\.trigger:disabled\s*\{[^}]*background:#f1efe9;[^}]*opacity:1;/s);
});

test("对话工作台只展示当前保留的终端与算力能力", async () => {
  const drawer = await readFile(workbenchPath, "utf8");
  assert.match(drawer, /\["terminal", SquareTerminal, "终端"\]/);
  assert.match(drawer, /\["scheduler", ServerCog, "算力"\]/);
  assert.match(drawer, /profile\.features\.terminal\.available/);
  assert.match(drawer, /candidate === "terminal"[\s\S]+?profile\.features\.terminal\.available && profile\.features\.terminal\.pty[\s\S]+?return profile\.features\.terminal\.available/);
  assert.match(drawer, /<TerminalPane[\s\S]+?<SchedulerPane/);
  assert.doesNotMatch(drawer, /RemoteFilesPane|VersionPane|TasksPane|ArtifactsPane/);
});

test("Agent 按钮及三级菜单使用统一字体栈和完整字号层级", async () => {
  const styles = await readFile(controlStylePath, "utf8");
  assert.match(styles, /--agent-font:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif/);
  assert.match(styles, /\.trigger\s*\{[^}]*max-width:190px;[^}]*height:38px;[^}]*font-size:13px;/s);
  assert.match(styles, /\.rootIdentity strong\s*\{[^}]*color:#343229;[^}]*font-size:14px;[^}]*font-weight:620;/s);
  assert.match(styles, /\.rootIdentity em\s*\{[^}]*font-size:10\.5px;[^}]*font-weight:520;/s);
  assert.match(styles, /\.rootIdentity small\s*\{[^}]*font-size:12px;/s);
  assert.match(styles, /\.inlineAction\s*\{[^}]*font-size:11\.5px;[^}]*font-weight:640;/s);
  assert.match(styles, /\.rootManual\s*\{[^}]*font-size:13\.5px;/s);
  assert.match(styles, /\.configPanel,\.configPanel :is\(button,label,select,input,strong\)\s*\{\s*font-size:14px;/s);
  assert.match(styles, /\.optionCopy small\s*\{[^}]*font-size:12px;[^}]*font-weight:440;/s);
  assert.match(styles, /\.nativeSetting select,\.nativeSetting input\s*\{[^}]*font-size:14px;/s);
  assert.match(styles, /\.nativeSetting\s*\{[^}]*grid-template-columns:78px minmax\(0,1fr\);/s);
  assert.match(styles, /\.selectControl > svg\s*\{[^}]*right:11px;/s);
  assert.match(styles, /\.modelList > button\s*\{[^}]*font-size:14px;/s);
  assert.match(styles, /\.modelList strong\s*\{[^}]*font-size:13px;[^}]*font-weight:610;/s);
  assert.match(styles, /\.modelList small\s*\{[^}]*font-size:10\.5px;/s);
  assert.match(styles, /\.menuState\s*\{[^}]*font-size:13px;/s);
});

test("Claude Code 的连续流式文本分片只渲染为一条 Agent 消息", async () => {
  const [view, timeline] = await Promise.all([readFile(viewPath, "utf8"), readFile(timelinePath, "utf8")]);
  assert.match(view, /mergeConversationEvents\(current, incoming\)/);
  assert.match(timeline, /const textIndexes = new Map<string, number>\(\)/);
  assert.match(timeline, /const key = `\$\{event\.producer\}:\$\{event\.kind\}:\$\{stableSource \|\| event\.eventId\}`/);
  assert.match(timeline, /const nextText = payload\.delta \? `\$\{textFrom\(previousPayload\)\}\$\{textFrom\(payload\)\}`/);
});

test("Agent 调用活动区保留完整命令、文件与事件内容，并采用清晰工作流层级", async () => {
  const [timeline, styles, view] = await Promise.all([readFile(timelinePath, "utf8"), readFile(timelineStylePath, "utf8"), readFile(viewPath, "utf8")]);
  assert.match(timeline, /function CommandItem/);
  assert.match(timeline, /function OperationGroup/);
  assert.match(timeline, /function DiffView/);
  assert.match(timeline, /function FileItem/);
  assert.match(timeline, /const operation = \/\^\(\?:edit\|write\|write_file\|create_file\|apply_patch\)\$\/.+\? "edit" : "read"/);
  assert.match(timeline, /reading \? "读取文件" : "编辑文件"/);
  assert.match(timeline, /reading \? "复制文件内容" : "复制文件修改内容"/);
  assert.match(timeline, /shell \? "运行命令" : search \? "搜索内容" : discover \? "查找文件" : "调用工具"/);
  assert.match(timeline, /tool\.shell \? "复制命令和输出" : "复制工具输入和结果"/);
  assert.doesNotMatch(timeline.match(/function CommandItem[\s\S]+?\n\}/)?.[0] || "", /<b>\$<\/b>/);
  assert.doesNotMatch(timeline, /function FileGroup/);
  assert.match(timeline, /const mergedFiles = mergedFileEntries\(events\.filter\(\(event\) => event\.kind === "file_change"\)\)/);
  assert.match(timeline, /function pathFromDiff\(diff: string\)/);
  assert.match(timeline, /value\.filename \|\| pathFromDiff\(diff\)/);
  assert.match(timeline, /function EventRow/);
  assert.match(timeline, /function AgentThought/);
  assert.match(timeline, /export \{ splitRemoteFinalPresentation \} from/);
  assert.match(copySource, /export function splitRemoteFinalPresentation/);
  assert.ok(copySource.includes("const match = content.match(/^([\\s\\S]*?\\S)\\n{2,}(#{1,6}[ \\t]+\\S[\\s\\S]*)$/);"));
  assert.match(copySource, /structured[\s\S]+?activity\.length > 500[\s\S]+?lines\.length > 3/);
  assert.match(timeline, /function AgentFinalActivity/);
  assert.match(timeline, /finalActivities[\s\S]+?event\.kind === "final"[\s\S]+?splitRemoteFinalPresentation/);
  assert.match(timeline, /finalActivities\.map\(\(content, index\) => <AgentFinalActivity/);
  assert.match(view, /const rawDisplayedContent = !user && timelineMode === "work" && message\.taskId[\s\S]+?splitRemoteFinalPresentation\(message\.content\)\.body[\s\S]+?const displayedContent = user \? rawDisplayedContent : stripArtifactPlaceholderLines/);
  assert.match(view, /<ConversationAnswer content=\{rawDisplayedContent\} events=\{timelineEvents \|\| \[\]\} artifacts=\{artifacts\} artifactHistory=\{artifactHistory\}/);
  assert.match(timeline, /function settledEvents/);
  assert.doesNotMatch(timeline, /未收到仍在运行的持续检查任务|unsupportedFutureFollowupClaim/);
  assert.doesNotMatch(view, /effectivePlanStatus/);
  assert.match(view, /data-status=\{step\.status\}/);
  assert.match(view, /planStepIcon\(step\.status, 13\)/);
  assert.match(timeline, /function remoteTaskStatus\(events: RealtimeEnvelope\[], taskById:/);
  assert.match(timeline, /if \(!TERMINAL_TASK_STATUSES\.has\(status\)\)[\s\S]+?taskById\[taskId\]\?\.status[\s\S]+?TERMINAL_TASK_STATUSES\.has\(taskStatus\)/);
  assert.match(timeline, /event\.producer === "task-orchestrator" && \(event\.kind === "error" \|\| event\.status === "failed"\)/);
  assert.match(view, /<ConversationTimeline events=\{timelineEvents \|\| \[\]\} mode=\{timelineMode\}[\s\S]+?taskById=\{taskById\}/);
  assert.match(view, /<ConversationTimeline events=\{pendingTimelineEvents\} mode=\{activeMode\} taskById=\{tasks\}/);
  assert.match(timeline, /function useTimelineDisclosure/);
  assert.doesNotMatch(timeline.match(/function isRunningEvent[\s\S]+?\n\}/)?.[0] || "", /waiting|null/);
  assert.match(timeline, /cancelled \? <Square size=\{8\} \/>/);
  assert.match(timeline, /event\.kind === "index_status"/);
  assert.match(timeline, /event\.kind === "terminal_output"/);
  assert.match(timeline, /event\.kind === "file_transfer"/);
  assert.match(timeline, /function eventDetailLabel/);
  assert.match(timeline, /payload: mergedNestedPayload\(previous, event/);
  assert.match(timeline, /finishedPayload\.delta === true/);
  assert.match(timeline, /if \(event\.kind === "command"\)[\s\S]+?commandId[\s\S]+?callIndexes\.has\(commandKey\)/);
  assert.match(timeline, /file\.delta[\s\S]+?previous\?\.diff/);
  assert.match(timeline, /segment.type === "operations"\) return <OperationGroup/);
  assert.match(timeline, /event.kind === "message"\) return <AgentThought/);
  assert.match(timeline, /function substantiallySameFinalBody[\s\S]+?shorter\.length \/ longer\.length >= \.86/);
  assert.match(timeline, /function finalSummaryMessageIds/);
  assert.match(timeline, /for \(const event of events\)[\s\S]+?event\.kind === "message" && substantiallySameFinalBody\(normalizedActivityText\(event\), finalText\)[\s\S]+?hidden\.add\(event\.eventId\)/);
  assert.match(timeline, /if \(hidden\.has\(event\.eventId\)\) continue/);
  assert.match(timeline, /record\.messagePhase === "commentary" \|\| record\.delivery === "async"/);
  assert.match(timeline, /record\.messagePhase === "final_answer" \|\| substantiallySameFinalBody\(combined, finalText\)[\s\S]+?hidden\.add\(candidate\.eventId\)/);
  assert.match(timeline, /const finalMessageIds = finalSummaryMessageIds\(coalesced, finalTexts\)/);
  assert.match(timeline, /if \(finalMessageIds\.has\(event\.eventId\)\) continue/);
  assert.match(timeline, /finalTextHints\.map\(normalizeRemoteArtifactLinkText\)/);
  assert.match(timeline, /TERMINAL_TASK_STATUSES\.has\(status\) && finalTextHint \? \[finalTextHint\] : \[\]/);
  assert.match(view, /finalTextHint=\{displayedContent\}/);
  assert.doesNotMatch(timeline, /agentThoughtHeading|阶段输出/);
  assert.match(timeline, /aria-label="Agent 中间输出"[\s\S]+?className=\{styles\.agentThoughtContent\}/);
  assert.doesNotMatch(timeline.match(/function CommandItem[\s\S]+?\n\}/)?.[0] || "", /LoaderCircle/);
  assert.doesNotMatch(timeline.match(/function OperationGroup[\s\S]+?\n\}/)?.[0] || "", /LoaderCircle/);
  assert.doesNotMatch(timeline.match(/function FileItem[\s\S]+?\n\}/)?.[0] || "", /LoaderCircle/);
  assert.match(styles, /--activity-title-size:var\(--timeline-title-size\)/);
  assert.match(styles, /\.agentCallNoDetails \.agentCallHeading/);
  assert.match(styles, /\.remoteTerminal\s*\{/);
  assert.doesNotMatch(timeline, /terminalCaption|登录节点/);
  assert.match(styles, /\.fileDiff\s*\{/);
  assert.match(styles, /\.agentThought\s*\{/);
  assert.match(styles, /\.eventDetail\s*\{/);
  assert.match(styles, /\.blockCopyButton\s*\{/);
  const activityRule = styles.match(/\.agentActivity\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(activityRule, /--activity-row-inset:7px;/);
  assert.match(activityRule, /gap:2px;/);
  assert.match(activityRule, /margin:1px 7px 2px 11px;/);
  assert.match(activityRule, /--activity-content-inset:16px;/);
  assert.match(activityRule, /border-left:1px solid/);
  assert.match(activityRule, /padding:1px 0 0 var\(--activity-content-inset\);/);
  assert.match(styles, /\.activityGroup\s*\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(styles, /\.agentEvent\s*\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(styles, /\.agentThought\s*\{[^}]*background:transparent;/s);
  assert.match(styles, /\.groupHeading\s*\{[^}]*width:max-content;[^}]*grid-template-columns:[^}]*minmax\(0,auto\)[^}]*15px;[^}]*border-radius:0;/s);
  assert.match(styles, /\.commandSummary,\.fileSummary\s*\{[^}]*width:max-content;[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(styles, /\.eventSummary\s*\{[^}]*width:max-content;[^}]*grid-template-columns:[^}]*minmax\(0,auto\)[^}]*15px;[^}]*border-radius:0;/s);
  assert.match(styles, /\.groupHeading:hover\s*\{\s*background:transparent;/s);
  assert.match(styles, /\.groupHeading:hover strong\s*\{\s*color:var\(--ew-ink\);/s);
  assert.match(styles, /\.commandSummary:hover,\.fileSummary:hover\s*\{\s*background:transparent;/s);
  assert.match(styles, /\.commandSummary:hover code,\.fileSummary:hover \.fileCopy strong\s*\{\s*color:var\(--ew-ink\);/s);
  assert.match(styles, /\.eventSummary:hover\s*\{\s*background:transparent;/s);
  assert.match(styles, /\.eventSummary:hover \.eventCopy > strong\s*\{\s*color:var\(--ew-ink\);/s);
  assert.match(styles, /\.backgroundResult > button\s*\{[^}]*grid-template-columns:auto minmax\(0,auto\) 14px;/s);
  assert.match(styles, /\.backgroundResult > button,\.backgroundResultStatic\s*\{[^}]*width:max-content;[^}]*align-items:center;/s);
  assert.match(styles, /\.backgroundResult > button:hover\s*\{[^}]*background:transparent;[^}]*color:var\(--ew-ink\);/s);
  assert.match(styles, /\.handoffHeading:hover\s*\{[^}]*background:transparent;[^}]*color:#5d5852;/s);
  assert.match(styles, /\.commandList\s*\{[^}]*margin:0 7px 3px 11px;[^}]*border-left:/s);
  assert.match(styles, /\.eventDetail\s*\{[^}]*margin:0 8px 6px 11px;[^}]*border-left:/s);
  assert.match(styles, /\.agentThought\s*\{[^}]*margin:0;[^}]*border:0;[^}]*padding:2px 0;/s);
  assert.doesNotMatch(styles, /\.agentThoughtHeading\s*\{/);
  assert.doesNotMatch(styles, /\.agentCallRunning \.agentCallGlyph svg|\.running :is\([^}]+animation:spin/);
});

test("运行中发送槽位在原生终止与追加发送之间切换，并锁定 Agent 配置", async () => {
  const [view, styles, control, controlStyles, runtime, services] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(viewStylePath, "utf8"),
    readFile(controlPath, "utf8"),
    readFile(controlStylePath, "utf8"),
    readFile(runtimePath, "utf8"),
    readFile(servicesPath, "utf8"),
  ]);
  assert.match(view, /const hasPendingPrompt = Boolean\(value\.trim\(\)\)/);
  assert.match(view, /const showStopAction = taskRunning && Boolean\(onInterrupt\) && !hasPendingPrompt/);
  assert.match(view, /The Web Agent handoff phase has no remote process to interrupt yet/);
  assert.match(view, /showStopAction \? <span[\s\S]+?className=\{`\$\{styles\.send\} \$\{styles\.stop\}`\}[\s\S]+?: <span[\s\S]+?<button className=\{styles\.send\}/);
  assert.match(view, /aria-label=\{stopping \|\| activeTask\?\.status === "interrupting" \? "正在终止任务" : "终止任务"\}[\s\S]+?<LoaderCircle[\s\S]+?<Square size=\{14\} fill="currentColor"/);
  assert.doesNotMatch(view, /taskRunning && onInterrupt \?/);
  assert.doesNotMatch(view, /正在中断任务|已发送停止指令|任务已停止/);
  assert.match(view, /data-tooltip=\{busy \? "正在发送" : "发送消息"\}/);
  assert.match(view, /aria-label=\{busy \? "正在发送" : "发送消息"\}/);
  assert.doesNotMatch(view, /直接追加给当前 Agent|"追加消息"/);
  assert.match(view, /const inputDisabled = Boolean\(disabled \|\| pendingWebRun\)/);
  assert.match(view, /disabled=\{inputDisabled \|\| busy \|\| taskRunning\}/);
  assert.match(view, /\["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting"\]/);
  assert.match(view, /event\.kind === "run\.handoff\.dispatched"[\s\S]+?api\.get<TaskSummary>/);
  assert.match(view, /handedOffTaskIdsKey[\s\S]+?Promise\.allSettled/);
  assert.match(view, /settledTaskIdsKey[\s\S]+?"run\.persisted"[\s\S]+?Promise\.allSettled/);
  assert.match(view, /handedOffTaskIdsKey[\s\S]+?reconcileTaskHistory\(taskId/);
  assert.match(view, /settledTaskIdsKey[\s\S]+?reconcileTaskHistory\(taskId/);
  assert.match(view, /reconcileTaskHistory[\s\S]+?replayCompleteTaskHistory\(taskId, \(page\)/);
  assert.match(view, /const liveTaskIdsKey = \[\.\.\.new Set\(\[\.\.\.handedOffTaskIds, activeTaskId\]/);
  assert.match(view, /liveTaskIdsKey\.split\("\\n"\)\.map\(\(taskId\) => realtime\.subscribe\(`task:\$\{taskId\}`/);
  assert.match(view, /const taskReplayCursors = useRef\(new Map<string, number>\(\)\)/);
  assert.match(view, /\/events\?after=\$\{after\}&limit=500/);
  assert.match(view, /timer = window\.setTimeout\(\(\) => void poll\(\), 5_000\)/);
  assert.match(view, /\["run\.handoff\.dispatched", "run\.persisted", "run\.suspended", "run\.failed", "run\.superseded"\][\s\S]+?api\.get<TaskSummary>/);
  assert.doesNotMatch(view, /<button className=\{styles\.stop\}[^>]+中断当前任务/);
  assert.match(styles, /\.send\.stop/);
  assert.match(view, /disabled=\{Boolean\(activeTask\) \|\| pendingWorkHandoff\}[\s\S]+?canConfigure/);
  assert.doesNotMatch(view, /disabled=\{false\}[\s\S]+?canConfigure/);
  assert.match(control, /if \(!disabled\) return;[\s\S]+?setOpen\(false\);[\s\S]+?setPage\("root"\)/);
  assert.match(runtime, /\/api\/conversations\/:id\/interrupt/);
  assert.match(services, /return \{ taskId: task\.id, status: "interrupting", duplicate: Boolean\(submitted\?\.duplicate\) \}/);
  assert.match(services, /controller\.abort\(new ApiError\("WEB_RUN_INTERRUPTED", "请求已停止"/);
  assert.match(services, /\["WEB_RUN_GATEWAY_RESTARTED", "WEB_RUN_INTERRUPTED"\]\.includes\(payload\.code\)/);
  assert.match(view, /pendingWebRun=\{activeMode === "work" && pendingWorkHandoff\}/);
  assert.match(view, /canInterrupt=\{pendingWorkHandoff \|\| agentOperationAvailable\(selectedAgent, "interrupt"\)\}/);
  assert.match(control, /initialConfigLoading/);
  assert.match(control, /正在读取 Agent 配置/);
  assert.match(controlStyles, /\.configLoading/);
  assert.match(control, /void loadConfig\(agent, true\)/);
  assert.match(control, /setCompactError\(message\)/);
  assert.match(control, /className=\{styles\.operationError\} role="alert"/);
  assert.match(controlStyles, /\.operationError/);
});

test("原生审批提交后立即由 Task 状态收起旧审批按钮", async () => {
  const timeline = await readFile(timelinePath, "utf8");
  assert.match(timeline, /\(!taskStatus \|\| taskStatus === "waiting_approval"\)/);
  assert.doesNotMatch(timeline, /!TERMINAL_TASK_STATUSES\.has\(String\(taskStatus \|\| ""\)\)/);
  assert.match(timeline, /embedded\.status === "completed"[\s\S]+?"已允许"[\s\S]+?"处理中"/);
  assert.match(timeline, /const \[submitted, setSubmitted\] = useState<\{ requestId: string; decision: ApprovalDecision \} \| null>\(null\)/);
  assert.match(timeline, /&& !submittedDecision[\s\S]+?setSubmitted\(\{ requestId, decision \}\)/);
  assert.match(timeline, /catch \(reason\) \{[\s\S]+?setSubmitted\(null\)/);
  assert.match(timeline, /operationAlreadySettled \? previous\.status/);
});

test("新对话没有 live Task 时路由派生不会读取空 route", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /liveTask && liveTask\.conversationId === conversationId \? liveTask\.route\?\.agentId : null/);
  assert.match(view, /liveTask && liveTask\.conversationId === conversationId \? liveTask\.route\?\.workspaceId : null/);
  assert.match(view, /latestConversationTask\?\.route\?\.agentId/);
  assert.match(view, /latestConversationTask\?\.route\?\.workspaceId/);
});

test("新建 Work 环境初始化失败后仍进入已创建对话，防止重复创建", async () => {
  const source = await readFile(viewPath, "utf8");
  const firstWorkStart = source.slice(source.indexOf("const id = result.data.conversation.id"), source.indexOf("const current = summary"));
  assert.match(firstWorkStart, /finally\s*\{/);
  assert.match(firstWorkStart, /runtime\.navigate\(\{ kind: "conversation", conversationId: id \}/);
  assert.match(firstWorkStart, /conversationOpened = true/);
  assert.match(firstWorkStart, /if \(!conversationOpened\) runtime\.navigate/);
});

test("Work 首轮交接前失败后可幂等重试虚拟工作区且不会先写入悬空消息", async () => {
  const view = await readFile(viewPath, "utf8");
  const descriptor = view.slice(view.indexOf("const responseDescriptor"), view.indexOf("const uploadConversationFiles"));
  const existingSend = view.slice(view.indexOf("if (activeMode === \"work\" && activeTask?.status === \"running\")"), view.indexOf("const interrupt = async"));
  const normalSend = existingSend.slice(existingSend.indexOf("// Validate the complete response route"));
  assert.match(descriptor, /workspace === VIRTUAL_WORKSPACE[\s\S]+?workspacePreparation: \{ kind: "virtual", branchId \}/);
  assert.match(descriptor, /agentConfigSourceScope: configScope/);
  assert.doesNotMatch(descriptor, /agentLabel = [^;]*"已选 Agent"/);
  assert.match(normalSend, /const response = responseDescriptor\(undefined, resources, selection\);[\s\S]+?const sent = await appendConversationMessage/);
  assert.ok(normalSend.indexOf("const response = responseDescriptor") < normalSend.indexOf("const sent = await appendConversationMessage"));
  assert.match(view, /latestResponseOrphaned[\s\S]+?responseRecoveryMessageId === latestResponseUserId/);
  assert.match(view, /orphanRecoveryDelay\(latestResponseCreatedAt\) \+ 50/);
  assert.match(view, /latestResponseTaskSettled \|\| latestResponseRunSettled \|\| latestResponseOrphaned/);
});

test("远程连接错误只在当前弹框实际发起连接失败后显示", async () => {
  const [dialog, manager] = await Promise.all([readFile(connectionDialogPath, "utf8"), readFile(serverManagerPath, "utf8")]);
  assert.match(dialog, /connectionAttemptError/);
  assert.match(dialog, /const displayedError = busy !== "connect"/);
  assert.match(dialog, /connectionAttemptError\?\.serverId === selected\.profile\.id/);
  assert.match(dialog, /setConnectionAttemptError\(null\);[\s\S]+?runtime\.api\.post\(`\/api\/servers\/\$\{encodeURIComponent\(id\)\}\/connect`/);
  assert.match(dialog, /setConnectionAttemptError\(\{ serverId: id, message \}\)/);
  assert.match(dialog, /SSH 已连接，但当前对话关联失败/);
  assert.match(dialog, /await onConnected\(id\)\.catch\(\(\) => onChanged\(\)\.catch/);
  assert.doesNotMatch(dialog, /attemptedServerIds/);
  assert.doesNotMatch(dialog, /selected\.connection\.lastError && !fingerprint \?/);
  assert.doesNotMatch(dialog, /\[load, runtime, selectedServerId\]/);
  assert.match(dialog, /\[load, notify, selectedServerId\]/);
  assert.match(manager, /value === "failed" \? "disconnected" : value/);
  assert.doesNotMatch(manager, /server\.connection\.lastError \? <div/);
});

test("网页上下文区分模型原生 usage 与明确标注的估算值", async () => {
  const [dialog, services] = await Promise.all([readFile(webContextDialogPath, "utf8"), readFile(servicesPath, "utf8")]);
  assert.match(dialog, /native-plus-estimate/);
  assert.match(dialog, /来自模型最近一次返回的原生 token usage/);
  assert.match(dialog, /当前仅估算持久消息，不冒充精确 token 数/);
  assert.match(dialog, /part\.source === "estimated" \? "（估算）"/);
  assert.match(services, /nativeWebUsage/);
  assert.match(services, /runs\.listCompleted/);
  assert.match(services, /model_input/);
  assert.match(services, /remote_reply/);
  assert.doesNotMatch(services, /function estimatedTokens\(value\) \{\s*return Math\.max\(0, Math\.ceil\(String\(value \|\| ""\)\.length \/ 4\)\);/);
});

test("Composer 复用流式资源上传，Chat 与 Work 共用文件概览，并保留精确 Skill pins", async () => {
  const [view, resources, services] = await Promise.all([readFile(viewPath, "utf8"), readFile(resourcesPath, "utf8"), readFile(servicesPath, "utf8")]);
  assert.match(view, /uploadResource\(api, file/);
  assert.doesNotMatch(view, /contentBase64|FileReader/);
  assert.match(resources, /\/api\/collections/);
  assert.match(resources, /\/api\/skills/);
  assert.match(view, /scope\.selectedCollectionIds/);
  assert.match(view, /scope\.selectedResourceVersions/);
  assert.match(services, /project\?\.collectionIds/);
  assert.match(services, /this\.container\.resources\.catalog/);
  assert.match(services, /this\.container\.resources\.catalog\(\{[\s\S]+?scope,[\s\S]+?all: true,[\s\S]+?summary: \{ required: true/);
  assert.match(services, /const workResourceToolsPromise = mode === "work"[\s\S]+?Array\.isArray\(catalog\?\.items\) && catalog\.items\.length > 0/);
  assert.match(services, /memoryCatalogFragmentsPromise/);
  assert.match(services, /const resourceCatalogPromise = !skipWebAgentModel[\s\S]+?prompts\.resourceCatalog/);
  assert.doesNotMatch(services, /const resourceCatalogPromise = mode === "work"/);
  assert.doesNotMatch(services, /initialToolChoice:\s*forceResourceSearch/);
  assert.match(view, /scope\.skillPins/);
  assert.match(services, /this\.container\.skills\.pinTask/);
  assert.match(services, /created\.task\.skillPins/);
});

test("新建远端会话未附加普通上下文时仍展示原生部署的 Skill", async () => {
  const timeline = await readFile(timelinePath, "utf8");
  assert.match(timeline, /\["append", "resume"\]\.includes[\s\S]+?references: \[\]/);
  assert.match(timeline, /payload\.contextIncluded === false[\s\S]+?references: handoff\.references\.filter[\s\S]+?toLocaleLowerCase\(\) === "skill"/);
  assert.doesNotMatch(timeline, /\["append", "resume"\]\.includes\(String\(payload\.operation \|\| ""\)\) \|\| payload\.contextIncluded === false/);
});

test("Work 消息重试、分支与回溯交给后端版本事务", async () => {
  const [view, services] = await Promise.all([readFile(viewPath, "utf8"), readFile(servicesPath, "utf8")]);
  assert.doesNotMatch(view, /工作区文件版本回退不可用|disabled=\{workMode\}/);
  assert.match(view, /onBranchCreated=\{openBranchedConversation\}/);
  assert.match(services, /#rewindWorkFiles/);
  assert.match(services, /selectRetainedVersionCheckpoint\(state, retainedInWorkspace,[\s\S]+?followingTask:\s*removedInWorkspace\[0\]/);
  assert.match(services, /#versionScopesForTasks[\s\S]+?latestBindingByWorkspace/);
  assert.match(services, /taskSummaries\.map\(\(task\) => this\.container\.taskStore\.getTask\(task\.id\)\)/);
  assert.match(services, /firstRemovedAt[\s\S]+?task\.createdAt >= firstRemovedAt/);
  assert.match(services, /selectRetainedVersionCheckpoint\(versionState, prefixWorkspaceTasks,[\s\S]+?boundaryRole:\s*boundary\.role[\s\S]+?followingTask:\s*followingWorkspaceTask/);
  assert.match(services, /\.\.\.preparedVersions\.map\(\(preparedVersion\) => preparedVersion\.versioning\.forkDomain/);
  assert.match(services, /#tryNativeAgentFork/);
  assert.match(services, /operation:\s*"fork"[\s\S]+?lastTurnId/);
  assert.match(services, /skillPins:\s*clone\(boundary\?\.skillSnapshot\?\.skillPins/);
  assert.match(services, /recoveredSkillPins:\s*targetBinding\.native\.skillPins/);
  assert.match(services, /contextHub\.forkBindingCheckpoint/);
  assert.match(services, /inheritedUnits:\s*inheritedConversationUnits/);
  assert.match(services, /#tryNativeAgentRevert/);
  assert.match(services, /operation:\s*"revert"[\s\S]+?beforeTurnId/);
  assert.match(services, /contextHub\.restoreBindingCheckpoint/);
  assert.match(services, /workRoute\?\.route\?\.binding\?\.agentId === "opencode"[\s\S]+?dryRun: true/);
  assert.match(services, /sourceSessionId:[\s\S]+?targetSessionId[,}][\s\S]+?resumeSessionAt:/);
  assert.match(services, /if \(!native\.applied\) await this\.#advanceWorkEpoch/);
  assert.match(services, /#advanceWorkEpoch/);
  assert.match(services, /forkDomain/);
  assert.match(services, /switchBatch/);
  assert.match(view, /retainEventsForMessages/);
  assert.match(view, /messagesRef\.current = nextMessages/);
  assert.match(view, /retainConversationEvents/);
});

test("破坏性消息操作以同步锁阻止重复提交且不自动重放旧版本", async () => {
  const [view, services, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(servicesPath, "utf8"), readFile(viewStylePath, "utf8")]);
  assert.match(view, /const actionInFlight = useRef\(false\)/);
  assert.match(view, /if \(actionInFlight\.current\) return;[\s\S]+?actionInFlight\.current = true/);
  assert.doesNotMatch(view, /result = await submit\(latest\.data\.summary\.revision\)/);
  assert.doesNotMatch(view, /edit-latest|编辑消息|setEditing|styles\.editBox|styles\.editActions/);
  assert.doesNotMatch(services, /editLatestUserMessage|LATEST_USER_MESSAGE/);
  assert.doesNotMatch(styles, /\.editBox|\.editActions/);
});

test("消息操作按钮使用应用内悬停提示并以历史图标表达回溯", async () => {
  const [view, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(viewStylePath, "utf8")]);
  assert.match(view, /function MessageAction/);
  assert.match(view, /data-tooltip=\{label\}/);
  assert.match(view, /label=\{copied \? "已复制" : user \? "复制消息" : "复制回复"\}/);
  assert.doesNotMatch(view, /label="编辑消息"/);
  assert.match(view, /label="重新生成"/);
  assert.match(view, /label="重新生成本轮回复"/);
  assert.match(view, /retryableUserMessageId/);
  assert.match(view, /label="从这里创建分支对话"/);
  assert.match(view, /nativeConversation/);
  assert.match(view, /timelineMode === "chat"\) runtime\.notify\("网页分支已创建", "success"\)/);
  assert.match(view, /网页分支与远端 Agent 原生上下文已同步分叉/);
  assert.match(view, /远端 Agent 将在下一轮重新建立上下文/);
  assert.doesNotMatch(view, /boundary_not_completed/);
  assert.doesNotMatch(view, /从这里创建新的分支对话\？原对话会保持不变。/);
  assert.match(view, /创建分支对话\？/);
  assert.match(view, /会把这里之前的网页对话与记忆带到一个新的对话/);
  assert.match(view, /不会操作远端 Agent 或工作区文件/);
  assert.match(view, /两个对话之后各自记录历史/);
  assert.match(view, /恢复文件到分叉点，改动会作用于共享工作区，同目录下的其他 Agent 也会看到/);
  assert.match(view, /label="回溯到这里" icon=\{<History size=\{16\} \/>\}/);
  assert.doesNotMatch(view, /title="(?:复制|编辑|重试|分支|回溯)/);
  assert.match(styles, /\.messageAction::after\s*\{[^}]*content:\s*attr\(data-tooltip\);/s);
  assert.match(styles, /\.messageAction:hover::after,\.messageAction:focus-within::after\s*\{[^}]*opacity:\s*1;/s);
  assert.match(styles, /\.messageAction > button\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/s);
});

test("失效对话链接只恢复一次并返回首页，附属请求不会重复弹错", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /reason instanceof GatewayError[^\n]+reason\.code !== "CONVERSATION_NOT_FOUND"/);
  assert.match(view, /missingConversationHandled\.current === conversationId/);
  assert.match(view, /localStorage\.removeItem\(`easywork\.conversation-route:\$\{conversationId\}`\)/);
  assert.match(view, /sessionStorage\.removeItem\(`\$\{PENDING_SERVER_BINDING_PREFIX\}\$\{conversationId\}`\)/);
  assert.match(view, /runtime\.navigate\(\{ kind: "home" \}, \{ replace: true \}\)/);
  assert.match(view, /if \(!conversationId \|\| loadedConversationId !== conversationId\) return;/);
  assert.match(view, /if \(!recoverMissingConversation\(error\)\) notify\(error\.message, "error"\)/);
  assert.match(view, /if \(!controller\.signal\.aborted && !recoverMissingConversation\(reason\)\) notify/);
});
