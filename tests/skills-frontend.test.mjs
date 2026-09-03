import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSkillFrontmatter, readSkillMetadata, splitServerRules } from "../app/easywork/features/skills/skill-metadata.mjs";

const viewPath = new URL("../app/easywork/features/skills/SkillsView.tsx", import.meta.url);
const stylePath = new URL("../app/easywork/features/skills/SkillsView.module.css", import.meta.url);
const runtimePath = new URL("../app/easywork/runtime/AppRuntime.tsx", import.meta.url);
const apiPath = new URL("../gateway/core/http/api.mjs", import.meta.url);

test("技能范围由标题下标签打开，模式先于服务器，管理员编辑复用同一弹窗", async () => {
  const [view, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(stylePath, "utf8")]);
  const fields = view.slice(view.indexOf("function ApplicabilityFields"), view.indexOf("function ApplicabilityDialog"));
  assert.ok(fields.indexOf("适用模式") < fields.indexOf("适用服务器"));
  for (const option of ["全部模式", "聊天模式", "工作模式", "全部服务器", "普通服务器", "算力服务器", "是否强制启用该技能"]) assert.ok(fields.includes(option));
  assert.match(fields, /<fieldset disabled=\{chatOnly\}/);
  assert.match(fields, /!chatOnly \? <label/);
  assert.match(fields, /forceEnabled: event\.target\.value !== "chat" && value\.forceEnabled/);
  assert.match(view, /value\?\.mode === "chat"\) return "仅聊天模式可见"/);
  assert.match(view, /className=\{styles\.scopeButton\}[^>]+onClick=\{\(\) => setScopeOpen\(true\)\}/);
  assert.doesNotMatch(view, />适用范围<\/Button>/);
  const dialog = view.slice(view.indexOf("function ApplicabilityDialog"), view.indexOf("function errorMessage"));
  assert.match(dialog, /<Modal title="技能适用范围" size="compact"/);
  assert.doesNotMatch(dialog, /subtitle=|不符合条件的技能/);
  assert.match(view, /<DetailPage key=\{`\$\{view\.detailSource\}:\$\{view\.detailId\}`\}/);
  const editor = view.slice(view.indexOf("function EditMarketForm"), view.indexOf("function DetailPage"));
  assert.doesNotMatch(editor, /ApplicabilityFields|适用服务器/);
  assert.doesNotMatch(view, /scopeDraft|setScopeDraft/);
  assert.match(styles, /\.serverScopeFields:disabled\s*\{\s*opacity:/);
});

test("市场范围弹窗立即独立保存，更新版本但不重建内容编辑表单", async () => {
  const view = await readFile(viewPath, "utf8");
  const scopeSave = view.slice(view.indexOf("const saveApplicability ="), view.indexOf("if (loadedEndpoint !== endpoint)"));
  assert.match(scopeSave, /api\.patch<\{ item: SkillSummary \}>[\s\S]+?\{ applicability \}, \{ expectedRevision: detail\.revision/);
  assert.match(scopeSave, /applicability: saved\.applicability, revision: saved\.revision/);
  assert.doesNotMatch(scopeSave, /editing|load\(/);
  assert.ok(scopeSave.indexOf("api.patch") < scopeSave.indexOf("setScopeOpen(false)"));
  assert.match(view, /<EditMarketForm key=\{detail\.id\}/);
  const editor = view.slice(view.indexOf("function EditMarketForm"), view.indexOf("function DetailPage"));
  const contentSave = view.slice(view.indexOf("const saveMarketSkill ="), view.indexOf("const saveApplicability ="));
  assert.doesNotMatch(editor, /applicability/);
  assert.doesNotMatch(contentSave, /applicability/);
  assert.match(contentSave, /expectedRevision: detail\.revision/);
});

test("服务器规则输入接受中英文逗号、分号和换行，去除空白与重复项", () => {
  assert.deepEqual(splitServerRules(" server-a，107.ustc.edu.cn;server-b；server-c\r\nserver-a,  "), ["server-a", "107.ustc.edu.cn", "server-b", "server-c"]);
  assert.deepEqual(splitServerRules("  ,，;；\n"), []);
});

test("卸载使用版本恢复逻辑，同步列表缓存及过期确认对象", async () => {
  const view = await readFile(viewPath, "utf8");
  const uninstall = view.slice(view.indexOf("const uninstallSkill ="), view.indexOf("if (view.detailId && view.detailSource)"));
  assert.match(uninstall, /uninstallInstalledSkill\(runtime\.api, item/);
  assert.match(uninstall, /setInstalled\(items\)/);
  assert.match(uninstall, /installedSkillsAfterUninstall\(current, result\)/);
  assert.match(uninstall, /setPendingAction\(\(current\)/);
  assert.match(uninstall, /item: latest/);
});

test("技能页使用三标签、独立路由详情和文件列表，并提供站内技能管理操作", async () => {
  const [view, styles, runtime, api] = await Promise.all([readFile(viewPath, "utf8"), readFile(stylePath, "utf8"), readFile(runtimePath, "utf8"), readFile(apiPath, "utf8")]);
  assert.match(view, /已安装/);
  assert.match(view, /市场/);
  assert.match(view, /上传管理/);
  assert.match(view, /待审核/);
  assert.match(view, /已审核/);
  assert.match(view, /showUploader/);
  assert.match(view, /收起上传/);
  assert.match(view, /function DetailPage/);
  assert.match(view, /className=\{styles\.fileList\}/);
  assert.match(runtime, /detailSource\?: "installed" \| "market" \| "upload"/);
  assert.match(runtime, /`\/skills\/\$\{tab\}\$\{detail\}/);
  assert.doesNotMatch(view, /window\.confirm|ChevronDown|ChevronRight|activeVersion|版本切换|版本号/);
  assert.match(view, /<Modal/);
  assert.match(view, /onUninstall/);
  assert.match(view, /editMarketSkill/);
  assert.match(view, /startEditing/);
  assert.match(view, /fileUpdates/);
  assert.match(view, /技能内容/);
  assert.match(view, /packageFilesFromTransfer/);
  assert.match(view, /onDrop=\{dropFiles\}/);
  assert.match(view, /onPaste=\{pasteFiles\}/);
  assert.doesNotMatch(view, /webkitdirectory|folderInput|无需填写版本/);
  assert.match(view, /className=\{styles\.skillActions\}/);
  assert.match(view, /onInstall=\{\(item\)/);
  assert.match(view, /const installing = source === "market" && busy === item\.id && !item\.installed/);
  assert.match(view, /aria-busy=\{installing\}/);
  assert.match(view, /installing \? <LoaderCircle className=\{styles\.spin\}/);
  assert.match(view, /installing \? "安装中"/);
  assert.match(view, /const INSTALL_FEEDBACK_MS = 360/);
  assert.match(view, /feedbackRemaining > 0[\s\S]+?window\.setTimeout\(resolve, feedbackRemaining\)/);
  assert.match(view, /const loadTab = useCallback/);
  assert.doesNotMatch(view, /Promise\.allSettled/);
  assert.match(view, /styles\.skillScope/);
  assert.match(view, /网页 Agent 将立即无法检索或选择该技能/);
  assert.match(styles, /\.detailPage[\s\S]*height:\s*100%[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /\.skillCard[^}]*min-height:\s*96px/);
  assert.match(styles, /\.skillCard[^}]*border:\s*1px solid rgba/);
  assert.match(styles, /\.document pre[^}]*border-radius:\s*13px/);
  assert.match(styles, /\.dropZone[^}]*border:\s*1px dashed/);
  assert.match(styles, /\.markdownTextarea[^}]*min-height:/);
  assert.match(api, /\/api\/skill-center\/market\/\:id\/install/);
  assert.match(api, /DELETE", "\/api\/skill-center\/installed\/\:skillId/);
  assert.match(api, /\/api\/skill-center\/uploads\/\:id\/review/);
});

test("技能编辑去除冗余标题，名称简介输入框对齐并使用技能内容标签", async () => {
  const [view, styles] = await Promise.all([readFile(viewPath, "utf8"), readFile(stylePath, "utf8")]);
  const editor = view.slice(view.indexOf("function EditMarketForm"), view.indexOf("function DetailPage"));
  assert.doesNotMatch(editor, /编辑技能|修改名称、简介|Markdown 内容|editHeading/);
  assert.match(editor, /<span>技能名称<\/span><input/);
  assert.match(editor, /<span>简介<\/span><textarea/);
  assert.match(editor, /<span>技能内容<\/span>/);
  assert.match(editor, /aria-label=\{`\$\{activeFile\.path\} 技能内容`\}/);
  assert.match(styles, /\.editForm > label\s*\{[^}]*grid-template-rows:\s*auto 1fr/);
  assert.doesNotMatch(styles, /\.editHeading/);
});

test("上传技能可从 SKILL.md YAML 头识别名称和简介，解析失败不产生覆盖值", () => {
  const metadata = parseSkillFrontmatter(`---\nname: 代码与计算任务规范\ndescription: 规范 Agent 在 USTC 本科生算力平台创建代码、组织项目和交付结果的方式。\n---\n# 正文`);
  assert.deepEqual(metadata, {
    name: "代码与计算任务规范",
    description: "规范 Agent 在 USTC 本科生算力平台创建代码、组织项目和交付结果的方式。",
  });
  assert.deepEqual(parseSkillFrontmatter("# 没有 YAML 头"), {});
  assert.deepEqual(parseSkillFrontmatter("---\nname: [无法识别\ndescription:\n---\n"), {});
  assert.deepEqual(parseSkillFrontmatter("---\nname: 只识别名称\n---\n"), { name: "只识别名称" });
  assert.deepEqual(readSkillMetadata([
    { path: "references/note.md", content: "---\nname: 错误来源\n---" },
    { path: "nested/SKILL.md", content: "---\nname: 嵌套技能\ndescription: 嵌套简介\n---" },
  ]), { name: "嵌套技能", description: "嵌套简介" });
});
