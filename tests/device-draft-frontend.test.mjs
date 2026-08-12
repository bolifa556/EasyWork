import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const conversationPath = new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url);
const runtimePath = new URL("../app/easywork/runtime/AppRuntime.tsx", import.meta.url);

test("前端 Work 选择使用 Actor API，文本草稿只使用浏览器 sessionStorage", async () => {
  const source = await readFile(conversationPath, "utf8");
  assert.match(source, /api\.get<WorkDraftSnapshot>\("\/api\/drafts\/work"\)/);
  assert.match(source, /api\.patch<WorkDraftSnapshot>\("\/api\/drafts\/work"/);
  assert.match(source, /api\.delete<WorkDraftSnapshot>\("\/api\/drafts\/work"/);
  assert.match(source, /sessionStorage\.setItem\(storageKey, value\)/);
  assert.match(source, /runtime\.bootstrap\?\.actor\.id/);
  assert.doesNotMatch(source, /localStorage\.setItem\("easywork\.work-draft"/);
});

test("同设备登录 token 与设备 ID 持久化，帮助只在浏览器设备首次访问时自动打开", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.match(source, /const SESSION_KEY = "easywork\.session"/);
  assert.match(source, /const DEVICE_KEY = "easywork\.device"/);
  assert.match(source, /const DEVICE_INTRO_KEY = "easywork\.device-intro-seen"/);
  assert.match(source, /if \(consumeFirstDeviceVisit\(\)\)/);
  assert.match(source, /else if \(leaveFinishedDeviceIntro\(\)\)/);
  assert.doesNotMatch(source, /result\.data\.firstVisit \? \{ kind: "help" \} : \{ kind: "home" \}/);
  assert.match(source, /if \(previousToken\) await api\.post\("\/api\/auth\/logout"\)/);
  assert.doesNotMatch(source, /beforeunload|unload/);
});
