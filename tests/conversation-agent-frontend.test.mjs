import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewPath = new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url);
const controlPath = new URL("../app/easywork/features/conversation/AgentControl.tsx", import.meta.url);
const timelinePath = new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url);
const resourcesPath = new URL("../app/easywork/features/conversation/ComposerResources.tsx", import.meta.url);
const runtimePath = new URL("../gateway/core/runtime/runtime.mjs", import.meta.url);
const servicesPath = new URL("../gateway/core/runtime/services.mjs", import.meta.url);
const webToolsPath = new URL("../gateway/core/web-agent/tools.mjs", import.meta.url);

test("EasyWork Conversation 使用持久事件回放与唯一 Timeline，并保持严格生产顺序", async () => {
  const [view, timeline, runtime] = await Promise.all([readFile(viewPath, "utf8"), readFile(timelinePath, "utf8"), readFile(runtimePath, "utf8")]);
  assert.match(runtime, /\/api\/conversations\/:id\/events/);
  assert.match(runtime, /\/api\/tasks\/:id\/events/);
  assert.match(view, /<ConversationTimeline events=\{timelineByUserMessage\.get\(message\.id\) \|\| \[\]\}/);
  assert.doesNotMatch(view, /function EventRow|activityTimeline/);
  assert.match(timeline, /occurredAt\.localeCompare/);
  assert.match(timeline, /event\.kind === "run\.reasoning\.delta"/);
  assert.match(timeline, /event\.kind !== "run\.tool\.started"/);
  assert.match(timeline, /memory_search/);
  assert.match(timeline, /resource_search/);
  assert.match(timeline, /function WorkHandoff/);
  assert.match(timeline, /TaskPlanSummary/);
});

test("Agent 上下文、切换和运行控制只按真实 capability 启用", async () => {
  const [view, control, services, webTools] = await Promise.all([
    readFile(viewPath, "utf8"),
    readFile(controlPath, "utf8"),
    readFile(servicesPath, "utf8"),
    readFile(webToolsPath, "utf8"),
  ]);
  assert.match(control, /runtimeCapabilities\?\.\[operation\]\?\.availability === "available"/);
  assert.match(control, /Agent 未返回可验证的上下文上限/);
  assert.match(control, /\/context\?\$\{query\}/);
  assert.match(control, /\/compact/);
  assert.match(view, /workspace-switch\/describe/);
  assert.match(view, /仅补发它尚未收到的内容/);
  assert.match(view, /agentOperationAvailable\(selectedAgent, "append"\)/);
  assert.match(view, /agentOperationAvailable\(selectedAgent, "resume"\)/);
  assert.match(view, /agentOperationAvailable\(selectedAgent, "interrupt"\)/);
  assert.doesNotMatch(view, /\/api\/tasks\/\$\{activeTask\.id\}\/append/);
  assert.doesNotMatch(view, /\/api\/tasks\/\$\{activeTask\.id\}\/resume/);
  assert.match(services, /class RemoteTaskLifecycle/);
  assert.match(services, /operation: "create"/);
  assert.match(services, /operation: "append"/);
  assert.match(services, /operation: "resume"/);
  assert.doesNotMatch(webTools, /name: "task_(?:create|observe|append|interrupt|resume)"/);
});

test("Composer 复用流式资源上传、文件集和精确 Skill pins，不回退到 base64", async () => {
  const [view, resources, services] = await Promise.all([readFile(viewPath, "utf8"), readFile(resourcesPath, "utf8"), readFile(servicesPath, "utf8")]);
  assert.match(view, /uploadResource\(api, file/);
  assert.doesNotMatch(view, /contentBase64|FileReader/);
  assert.match(resources, /\/api\/collections/);
  assert.match(resources, /\/api\/skills/);
  assert.match(view, /scope\.selectedCollectionIds/);
  assert.match(view, /scope\.skillPins/);
  assert.match(services, /this\.container\.skills\.pinTask/);
  assert.match(services, /created\.task\.skillPins/);
});

test("Work 不具备文件回退能力时显式禁用破坏性消息操作", async () => {
  const view = await readFile(viewPath, "utf8");
  assert.match(view, /工作区文件版本回退不可用/);
  assert.match(view, /disabled=\{workMode\}/);
  assert.match(view, /onBranchCreated=\{bindWorkBranch\}/);
});
