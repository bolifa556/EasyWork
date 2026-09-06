import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../app/easywork/features/library/LibraryPage.tsx", import.meta.url);
const pageStylePath = new URL("../app/easywork/features/library/LibraryPage.module.css", import.meta.url);
const previewPath = new URL("../app/easywork/features/viewers/FilePreviewPanel.tsx", import.meta.url);
const uploadPath = new URL("../app/core/gateway/resource-upload.ts", import.meta.url);

test("文件库使用目标感知的文件与文件夹拖放上传", async () => {
  const [page, styles] = await Promise.all([readFile(pagePath, "utf8"), readFile(pageStylePath, "utf8")]);
  assert.match(page, /showDirectoryPicker/);
  assert.match(page, /webkitGetAsEntry/);
  assert.match(page, /filesFromDroppedEntry/);
  assert.match(page, /onDrop=\{\(event\) => uploadDrop\(event, row\.path\)\}/);
  assert.match(page, /onDrop=\{\(event\) => uploadDrop\(event, directory\)\}/);
  assert.match(page, /onUpload\(collection\.id, files\)/);
  assert.match(styles, /\.fileRow\.folderDropTarget\s*\{[^}]*background:\s*var\(--ew-green-soft\)/s);
  assert.match(styles, /\.collectionCard\.collectionDropTarget\s*\{[^}]*background:/s);
  assert.doesNotMatch(page, /webkitdirectory|setAttribute\("webkitdirectory"/);
});

test("文件库以面包屑和搜索栏旁返回按钮替代左侧目录树", async () => {
  const [page, styles] = await Promise.all([readFile(pagePath, "utf8"), readFile(pageStylePath, "utf8")]);
  assert.match(page, /aria-label="文件路径"/);
  assert.match(page, /aria-label="返回上一级目录"/);
  assert.match(page, /const parentDirectory = breadcrumbs\.slice\(0, -1\)\.join\("\/"\)/);
  assert.doesNotMatch(page, /DirectoryTree|directoryTree|aria-label="目录树"/);
  assert.doesNotMatch(styles, /\.directoryTree|\.activeDirectory/);
  assert.match(styles, /\.browserLayout\s*\{[^}]*max-width:\s*1280px;[^}]*margin:\s*0 auto;/s);
});

test("文件夹汇总后代文件索引状态，文件名悬停不添加下划线", async () => {
  const [page, styles] = await Promise.all([readFile(pagePath, "utf8"), readFile(pageStylePath, "utf8")]);
  assert.match(page, /failedCount === fileCount \? "unready" : failedCount > 0 \? "partial" : processingCount > 0 \? "processing" : "ready"/);
  assert.match(page, /部分就绪/);
  assert.match(page, /未就绪/);
  assert.match(page, /<FolderStatus folder=\{row\} \/>/);
  const hoverRule = styles.match(/\.fileNameButton:hover strong\s*\{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(hoverRule, /text-decoration|border-bottom|box-shadow/);
});

test("文件库的文件名打开应用共用的多标签预览", async () => {
  const [page, preview, view] = await Promise.all([readFile(pagePath, "utf8"), readFile(previewPath, "utf8"), readFile(new URL("../app/easywork/features/library/LibraryView.tsx", import.meta.url), "utf8")]);
  assert.match(page, /className=\{`\$\{styles\.fileName\} \$\{styles\.fileNameButton\}`\}[^>]+onClick=\{\(\) => onPreview\(row\)\}/);
  assert.doesNotMatch(page, />预览<\/Button>|<Eye/);
  assert.match(preview, /ConversationWorkspacePreview\.module\.css/);
  assert.match(preview, /className=\{styles\.previewPanel\}/);
  assert.match(preview, /className=\{styles\.tabBar\}/);
  assert.match(view, /onPreviewFile=\{\(file\) => openFilePreview\(/);
  assert.match(view, /source: \{ kind: "resource", resourceVersionId: file\.id \}/);
  assert.doesNotMatch(view, /LibraryFilePreview|setPreviewFile/);
});

test("文件库标题与文件集名称下方不展示冗余计数", async () => {
  const page = await readFile(pagePath, "utf8");
  assert.doesNotMatch(page, /\{collections\.length\}/);
  assert.doesNotMatch(page, /\{collection\.fileCount\} 个文件/);
});

test("资源上传在 SubtleCrypto 不可用时仍能计算完整性摘要", async () => {
  const upload = await readFile(uploadPath, "utf8");
  assert.match(upload, /globalThis\.crypto\?\.subtle/);
  assert.match(upload, /function sha256Fallback\(buffer: ArrayBuffer\)/);
  assert.match(upload, /return sha256Fallback\(content\)/);
  assert.doesNotMatch(upload, /await crypto\.subtle\.digest/);
});
