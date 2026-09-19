import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveWebModelSelection } from "../app/easywork/features/conversation/web-model-selection.mjs";

const providers = [
  { id: "provider-a", name: "A" },
  { id: "provider-b", name: "B" },
];

test("网页模型选择保留仍然有效的 Provider 和模型", () => {
  let storageReads = 0;
  const resolved = resolveWebModelSelection(providers, { providerId: "provider-b", modelId: "model-b" }, () => {
    storageReads += 1;
    return "cached";
  });
  assert.equal(resolved.selectedProvider.id, "provider-b");
  assert.equal(resolved.activeModelId, "model-b");
  assert.equal(storageReads, 0);
});

test("删除当前 Provider 后切换到现存 Provider 自己保存的模型", () => {
  const remaining = providers.filter((provider) => provider.id !== "provider-b");
  const resolved = resolveWebModelSelection(remaining, { providerId: "provider-b", modelId: "deleted-model" }, (id) => id === "provider-a" ? "model-a" : "");
  assert.equal(resolved.selectedProvider.id, "provider-a");
  assert.equal(resolved.activeModelId, "model-a");
});

test("删除最后一个 Provider 后清空旧模型选择", () => {
  const resolved = resolveWebModelSelection([], { providerId: "provider-b", modelId: "deleted-model" }, () => "should-not-survive");
  assert.equal(resolved.selectedProvider, null);
  assert.equal(resolved.activeModelId, "");
});

test("个人设置加载状态和删除后的全局列表更新接入聊天模型菜单", async () => {
  const [dialog, dialogStyles, runtime, view] = await Promise.all([
    readFile(new URL("../app/easywork/shell/AccountDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/easywork/shell/AccountDialog.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/easywork/runtime/AppRuntime.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(dialog, /setProvidersLoading\(true\)[\s\S]+?setAccountTab\("providers"\)[\s\S]+?finally \{ setProvidersLoading\(false\); \}/);
  assert.match(dialog, /providersLoading \? <div className=\{styles\.providerLoading\} role="status"[\s\S]+?正在加载模型 API/);
  assert.match(dialogStyles, /\.providerLoading\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(dialog, /runtime\.removeModelProvider\(deletedProviderId\)/);
  assert.match(runtime, /const removeModelProvider = useCallback[\s\S]+?providers\.filter\(\(provider\) => provider\.id !== providerId\)/);
  assert.match(view, /resolveWebModelSelection\([\s\S]+?availableProviders[\s\S]+?\{ providerId, modelId \}/);
  assert.match(view, /onSend\(prompt, pendingResources, \{ providerId: chosenProviderId, modelId: activeModelId \}/);
  assert.match(view, /const resolvedSelection = resolveWebModelSelection\([\s\S]+?const providerId = resolvedSelection\.selectedProvider\?\.id;[\s\S]+?const selectedModel = resolvedSelection\.activeModelId;/);
  assert.match(view, /providerPageActive \?[\s\S]+?availableProviders\.map/);
});
