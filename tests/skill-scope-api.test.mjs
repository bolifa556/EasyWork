import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";

async function scopeApiFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-skill-scope-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gateway = await createGatewayServer({ runtimeOptions: { dataRoot: path.join(root, "data") } });
  t.after(() => gateway.close());
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  async function request(route, { token, method = "GET", body, revision, command } = {}) {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(revision === undefined ? {} : { "if-match": `"${revision}"` }),
        ...(command ? { "idempotency-key": command } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  return request;
}

test("范围 PATCH 经真实 HTTP 保存，市场默认与个人配置分离且错误不覆盖已保存范围", async (t) => {
  const request = await scopeApiFixture(t);
  const register = (username) => request("/api/auth/register", { method: "POST", body: { username, password: "skill-scope-password", deviceId: username } });
  const admin = (await register("scope-admin")).data.token;
  const user = (await register("scope-user")).data.token;
  const submitted = await request("/api/skill-center/uploads", {
    token: admin, method: "POST", command: "scope-upload",
    body: { name: "独立范围", description: "保留原简介", files: [{ path: "SKILL.md", content: "# 独立范围\n\n只读项目说明。" }] },
  });
  assert.equal(submitted.status, 200);
  const review = await request(`/api/skill-center/uploads/${submitted.data.item.id}/review`, {
    token: admin, method: "POST", revision: submitted.data.item.revision, body: { decision: "approve" }, command: "scope-approve",
  });
  assert.equal(review.status, 200);
  const item = review.data.market;
  const marketPath = `/api/skill-center/market/${item.id}`;
  const installedPath = `/api/skill-center/installed/${item.skillId}`;
  const scope = { mode: "all", serverKind: "compute", allowServers: ["107.ustc.edu.cn"], denyServers: ["blocked"], forceEnabled: true };
  const changed = await request(marketPath, { token: admin, method: "PATCH", revision: item.revision, body: { applicability: scope } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.item.name, "独立范围");
  assert.equal(changed.data.item.description, "保留原简介");
  assert.deepEqual(changed.data.item.applicability, scope);
  assert.equal((await request(marketPath, { token: user, method: "PATCH", revision: changed.data.item.revision, body: { applicability: scope } })).status, 403);
  assert.equal((await request(`${marketPath}/install`, { token: user, method: "POST", body: {} })).status, 200);
  assert.deepEqual((await request(installedPath, { token: user })).data.applicability, scope);
  const personal = { ...scope, serverKind: "standard", allowServers: ["my-server"], forceEnabled: false };
  assert.equal((await request(`${installedPath}/applicability`, { token: user, method: "PATCH", body: personal })).status, 200);
  assert.deepEqual((await request(marketPath, { token: user })).data.applicability, scope);
  const invalid = await request(`${installedPath}/applicability`, { token: user, method: "PATCH", body: { ...personal, denyServers: ["MY-SERVER"] } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.error.code, "SKILL_APPLICABILITY_CONFLICT");
  assert.deepEqual((await request(installedPath, { token: user })).data.applicability, personal);
  const latest = await request(marketPath, { token: admin, method: "PATCH", revision: changed.data.item.revision, body: { applicability: { mode: "chat" } } });
  assert.equal(latest.status, 200);
  assert.deepEqual((await request(installedPath, { token: user })).data.applicability, personal);
  assert.equal((await request(`${marketPath}/install`, { token: user, method: "POST", body: {} })).status, 200);
  assert.deepEqual((await request(installedPath, { token: user })).data.applicability, personal);
});

test("管理员编辑中的范围先独立落盘，后续内容保存使用新版本且不覆盖范围", async (t) => {
  const request = await scopeApiFixture(t);
  const token = (await request("/api/auth/register", { method: "POST", body: { username: "scope-editor", password: "scope-editor-password", deviceId: "scope-editor" } })).data.token;
  const originalContent = "# 原技能内容\n\n这是已发布的说明。";
  const uploaded = (await request("/api/skill-center/uploads", {
    token, method: "POST", command: "scope-editor-upload",
    body: { name: "编辑保存验证", description: "已发布简介", files: [{ path: "SKILL.md", content: originalContent }] },
  })).data.item;
  const original = (await request(`/api/skill-center/uploads/${uploaded.id}/review`, {
    token, method: "POST", revision: uploaded.revision, command: "scope-editor-review", body: { decision: "approve" },
  })).data.market;
  const endpoint = `/api/skill-center/market/${original.id}`;
  const scope = { mode: "work", serverKind: "compute", allowServers: ["scope-server"], denyServers: ["blocked-server"], forceEnabled: true };
  const savedScope = await request(endpoint, { token, method: "PATCH", revision: original.revision, body: { applicability: scope } });
  assert.equal(savedScope.status, 200);
  assert.equal(savedScope.data.item.revision, original.revision + 1);

  // A fresh detail request represents leaving the editor without saving its text draft.
  const afterScope = (await request(endpoint, { token })).data;
  assert.deepEqual(afterScope.applicability, scope);
  assert.equal(afterScope.name, "编辑保存验证");
  assert.equal(afterScope.description, "已发布简介");
  assert.equal(afterScope.files.find((file) => file.path === "SKILL.md").content, originalContent);

  const contentDraft = { name: "编辑保存验证（已更新）", description: "新的简介", fileUpdates: [{ path: "SKILL.md", content: "# 新技能内容\n\n这是新保存的说明。" }] };
  const staleSave = await request(endpoint, { token, method: "PATCH", revision: original.revision, body: contentDraft });
  assert.equal(staleSave.status, 409);
  assert.equal(staleSave.error.code, "REVISION_CONFLICT");
  const savedContent = await request(endpoint, { token, method: "PATCH", revision: savedScope.data.item.revision, body: contentDraft });
  assert.equal(savedContent.status, 200);
  const afterContent = (await request(endpoint, { token })).data;
  assert.deepEqual(afterContent.applicability, scope);
  assert.equal(afterContent.name, contentDraft.name);
  assert.equal(afterContent.description, contentDraft.description);
  assert.equal(afterContent.files.find((file) => file.path === "SKILL.md").content, contentDraft.fileUpdates[0].content);
});
