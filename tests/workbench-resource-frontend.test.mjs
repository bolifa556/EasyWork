import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JOB_COLUMNS, MAX_JOB_COLUMN_WIDTH, normalizeJobColumnWidths, resizeJobColumn } from "../app/easywork/features/workbench/job-table-columns.ts";

const schedulerPath = new URL("../app/easywork/features/workbench/SchedulerPane.tsx", import.meta.url);
const drawerPath = new URL("../app/easywork/features/workbench/WorkbenchDrawer.tsx", import.meta.url);
const drawerStylePath = new URL("../app/easywork/features/workbench/WorkbenchDrawer.module.css", import.meta.url);
const sidebarPath = new URL("../app/easywork/features/workspace/WorkspaceSidebar.tsx", import.meta.url);
const sidebarStylePath = new URL("../app/easywork/features/workspace/WorkspaceSidebar.module.css", import.meta.url);
const versionPath = new URL("../app/easywork/features/workspace/WorkspaceVersionView.tsx", import.meta.url);
const conversationPath = new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url);
const shellPath = new URL("../app/easywork/shell/AppShell.tsx", import.meta.url);
const libraryPath = new URL("../app/easywork/features/library/LibraryView.tsx", import.meta.url);

test("workspace downloads use an EasyWork-issued streaming link and extensionless entries remain file-like", async () => {
  const [sidebar, conversation] = await Promise.all([readFile(sidebarPath, "utf8"), readFile(conversationPath, "utf8")]);
  assert.match(sidebar, /files\/download/);
  assert.match(sidebar, /document\.createElement\("a"\)/);
  assert.doesNotMatch(sidebar, /response\.blob\(|URL\.createObjectURL/);
  assert.match(sidebar, /return canPreviewFile\(entry\)/);
  assert.match(sidebar, /contextEntry && contextEntry\.kind !== "directory"[\s\S]+?打开预览/);
  assert.match(sidebar, /<Download size=\{15\} \/>下载…/);
  assert.doesNotMatch(conversation, /RemoteFileDialog|setRemoteFilesOpen|>文件<\/button>/);
});

test("workspace rows reveal their action button on desktop hover and keep it visible on touch layouts", async () => {
  const [sidebar, styles] = await Promise.all([readFile(sidebarPath, "utf8"), readFile(sidebarStylePath, "utf8")]);
  assert.match(sidebar, /className=\{styles\.treeRowMenu\}[\s\S]+?aria-haspopup="menu"[\s\S]+?aria-expanded=\{context\?\.entry\?\.path === entry\.path\}/);
  assert.match(styles, /\.treeRow\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) 28px;[^}]*align-items:center;/s);
  assert.match(styles, /\.treeRowMenu\s*\{[^}]*display:grid;[^}]*opacity:0;[^}]*pointer-events:none;/s);
  assert.match(styles, /\.treeRow:hover \.treeRowMenu,\.treeRowMenu:focus-visible\s*\{[^}]*opacity:1;[^}]*pointer-events:auto;/s);
  assert.match(styles, /\.treeRow:hover,[^{]+\{[^}]*background:/s);
  assert.doesNotMatch(styles, /\.treeRow:hover \.treeRowMain,[^{]+\{[^}]*background:/s);
  assert.match(sidebar, /onContextMenu=\{\(event\) => openContext\(event, entry\)\}/);
  assert.match(sidebar, /onClick=\{\(event\) => openContext\(event, entry\)\}/);
  assert.equal((sidebar.match(/className=\{styles\.contextMenu\}/g) || []).length, 1, "省略号和右键只使用一个菜单实例");
  assert.match(styles, /@media \(max-width:720px\)[\s\S]+?\.treeRowMenu\s*\{[^}]*opacity:1;[^}]*pointer-events:auto;/s);
});

test("workspace Version shows the user's Git repository rather than EasyWork conversation checkpoints", async () => {
  const source = await readFile(versionPath, "utf8");
  assert.match(source, /workspaces\/\$\{encodeURIComponent\(session\.workspaceId\)\}\/git\/status/);
  assert.match(source, /尚未建立 Git 仓库/);
  assert.match(source, /工作区变更/);
  assert.match(source, /提交历史/);
  assert.match(source, /aria-label="刷新 Git 版本" disabled=\{loading\}/);
  assert.doesNotMatch(source, /versioning\/status|versioning\/rewind|EasyWork 自动记录|回退到此版本|git init/);
});

test("collection deletion supplies the backend idempotency key", async () => {
  const source = await readFile(libraryPath, "utf8");
  assert.match(source, /api\.delete\(`\/api\/collections\/\$\{encodeURIComponent\(id\)\}`,[\s\S]+?idempotencyKey: commandId\("collection-delete"\)/);
});

test("scheduler job lists refresh on native notifications, entry, tab selection and mutations", async () => {
  const [source, styles] = await Promise.all([readFile(schedulerPath, "utf8"), readFile(drawerStylePath, "utf8")]);
  assert.match(source, /function Donut\(/);
  assert.match(source, /<BreakdownChart label="节点"/);
  assert.match(source, /<BreakdownChart label="CPU 核心"/);
  assert.match(source, /<BreakdownChart label="加速卡"/);
  assert.match(source, />当前作业</);
  assert.match(source, />历史作业</);
  assert.doesNotMatch(source, /我的作业|currentUserJobs/);
  assert.doesNotMatch(source, /ACTIVE_JOB_REFRESH_MS|setInterval\(\(\) => void loadCurrentJobs/);
  assert.match(source, /loadHistory\(initialHistoryRange, controller\.signal\)/);
  assert.match(source, /Promise\.all\(\[loadCurrentJobs\(\), loadHistory\(historyRange\)\]\)/);
  assert.match(source, /runtime\.realtime\?\.subscribe\(`scheduler:[\s\S]+?event\.kind === "jobs.changed"[\s\S]+?refreshJobs/);
  const chooseTabSource = source.slice(source.indexOf("const chooseJobTab"), source.indexOf("const chooseHistoryPreset"));
  assert.match(chooseTabSource, /loadCurrentJobs\(/);
  assert.match(chooseTabSource, /loadHistory\(/);
  assert.match(source, /onClick=\{\(\) => chooseJobTab\("history"\)\}/);
  assert.match(source, /onClick=\{\(\) => chooseJobTab\("current"\)\}/);
  assert.match(source, /window\.setInterval\(\(\) => void loadResources\(controller\.signal\), RESOURCE_REFRESH_MS\)/);
  assert.match(source, /window\.setInterval\(\(\) => void load\(controller\.signal, true\), 5_000\)/);
  assert.match(source, /scheduler\/resource-dashboard\?refresh=1/);
  assert.match(source, /startDate: range\.startDate, endDate: range\.endDate/);
  assert.match(source, /utcOffsetMinutes: String\(-new Date\(\)\.getTimezoneOffset\(\)\)/);
  assert.match(source, /historyError && !historicalJobs\.length[\s\S]+?历史作业暂时无法读取/);
  assert.deepEqual(JOB_COLUMNS.map((column) => column.label), ["作业名称 / ID", "应用", "队列 / 资源", "运行时长", "开始时间", "结束时间", "作业状态"]);
  assert.match(source, /<option value="30">近 1 个月<\/option>/);
  assert.match(source, /type="date" aria-label="历史作业开始日期"/);
  assert.match(source, /HISTORY_PAGE_SIZE = 50/);
  assert.match(source, /aria-label="历史作业分页"/);
  assert.doesNotMatch(source, /进入算力时读取|作业变化后更新/);
  assert.doesNotMatch(source, /jobTab === "current" \? <time>/);
  assert.doesNotMatch(source, /<small>提交<\/small>/);
  assert.match(styles, /\.jobName\s*\{[^}]*align-items:baseline;[^}]*white-space:nowrap;/s);
  assert.match(styles, /\.jobCell,[\s\S]+?\.jobStatusCell\s*\{[^}]*align-items:center;[^}]*white-space:nowrap;/s);
  assert.match(styles, /\.jobState\s*\{[^}]*padding:0;[^}]*background:transparent;/s);
  assert.doesNotMatch(styles, /\.job_(?:running|pending|failed|timeout|completed|cancelled)\s*\{[^}]*background:/s);
});

test("workbench and sidebar resizing paint once per animation frame and commit on release", async () => {
  const [drawer, shell] = await Promise.all([readFile(drawerPath, "utf8"), readFile(shellPath, "utf8")]);
  assert.match(drawer, /requestAnimationFrame\(paint\)/);
  assert.match(drawer, /drawerRef\.current\?\.style\.setProperty\("--workbench-height"/);
  assert.doesNotMatch(drawer, /onHeightPreview/);
  assert.match(shell, /requestAnimationFrame\(paint\)/);
  assert.match(shell, /shellRef\.current\?\.style\.setProperty\("--sidebar-current-width"/);
  const sidebarMove = shell.slice(shell.indexOf("const move = (moveEvent: PointerEvent)"), shell.indexOf("const stop = (stopEvent?: PointerEvent)"));
  assert.doesNotMatch(sidebarMove, /setSidebarWidth/);
});

test("作业行不再展开，取消为与文字同尺寸的内联按钮，两类表格共用可调整列宽", async () => {
  const [source, styles] = await Promise.all([readFile(schedulerPath, "utf8"), readFile(drawerStylePath, "utf8")]);
  assert.doesNotMatch(source, /expandedJob|loadOutput|jobOutput|onOpen|variant="danger"/);
  assert.match(source, /className=\{styles\.jobNameCell\} role="cell">\s*<span className=\{styles\.jobName\}/);
  assert.match(source, /window\.confirm\(`确定取消作业/);
  assert.match(source, /className=\{styles\.jobCancel\}/);
  assert.match(styles, /\.jobCancel\s*\{[^}]*min-height:0;[^}]*padding:0;[^}]*border:0;[^}]*background:transparent;/s);
  assert.equal((source.match(/onColumnWidthsChange=\{changeColumnWidths\}/g) || []).length, 2);
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /requestAnimationFrame\(\(\) =>/);
  assert.match(source, /onPointerCancel=\{\(event\) => finishColumnResize\(event, true\)\}/);
  assert.match(source, /onDoubleClick=\{\(\) => onColumnWidthsChange\(null\)\}/);
  assert.match(styles, /\.drawer\s*\{[^}]*position: relative;/s);
});

test("列宽仅改变目标列，并约束异常缓存和拖动边界", () => {
  const widths = JOB_COLUMNS.map((column) => column.width);
  const resized = resizeJobColumn(widths, 0, 73);
  assert.equal(resized[0], widths[0] + 73);
  assert.deepEqual(resized.slice(1), widths.slice(1));
  assert.equal(resizeJobColumn(widths, 0, -9000)[0], JOB_COLUMNS[0].min);
  assert.equal(resizeJobColumn(widths, 6, 9000)[6], MAX_JOB_COLUMN_WIDTH);
  assert.deepEqual(resizeJobColumn(widths, 10, 100), widths);
  assert.deepEqual(resizeJobColumn(widths, 0, Number.NaN), widths);
  assert.deepEqual(normalizeJobColumnWidths(widths), widths);
  for (const invalid of [null, {}, [1], widths.map(String), [...widths.slice(0, 6), Infinity]]) assert.equal(normalizeJobColumnWidths(invalid), null);
  assert.deepEqual(normalizeJobColumnWidths(widths.map(() => -1)), JOB_COLUMNS.map((column) => column.min));
});
