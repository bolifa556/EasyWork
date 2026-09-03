import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installedSkillsAfterUninstall, uninstallInstalledSkill } from "../app/easywork/features/skills/skill-uninstall.mjs";
import { createActorContext } from "../gateway/core/actor.mjs";
import { createGatewayServer } from "../gateway/core/server.mjs";
import { SkillService } from "../gateway/core/skills/index.mjs";

async function fixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-skill-uninstall-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const actor = createActorContext({ actorType: "user", actorId: "uninstall_owner", deviceId: "device_uninstall", sessionId: "session_uninstall", roles: [] });
  const service = new SkillService({ dataRoot, actor, authorizeTask: async () => true });
  const install = (skillId) => service.installPackage({
    skillId, version: "1.0.0",
    manifest: { name: skillId, description: "卸载回归测试", entrypoint: "SKILL.md", permissions: [] },
    files: [{ path: "SKILL.md", content: `# ${skillId}\n\n只读项目说明。` }],
  });
  await install("skill-a");
  await install("skill-b");
  const calls = [];
  const api = {
    async get(route) {
      assert.equal(route, "/api/skill-center/installed");
      calls.push({ method: "GET" });
      return { data: await service.listInstalled() };
    },
    async delete(route, { expectedRevision }) {
      calls.push({ method: "DELETE", expectedRevision });
      const skillId = decodeURIComponent(route.slice("/api/skill-center/installed/".length));
      return { data: await service.uninstall({ skillId, expectedRevision }) };
    },
  };
  return { service, api, calls, install };
}

test("连续卸载同步剩余技能的全局版本，正常请求不额外刷新列表", async (t) => {
  const { service, api, calls } = await fixture(t);
  const initial = (await service.listInstalled()).items;
  let items = initial;
  const firstRevision = initial[0].revision;
  while (items.length) {
    const result = await uninstallInstalledSkill(api, items[0], () => assert.fail("正常卸载不应请求刷新"));
    items = installedSkillsAfterUninstall(items, result);
    assert.deepEqual(items, (await service.listInstalled()).items);
  }
  assert.equal(initial.length, 2, "不能修改原缓存数组");
  assert.ok(initial.every((item) => item.revision === firstRevision));
  assert.deepEqual(calls, [{ method: "DELETE", expectedRevision: firstRevision }, { method: "DELETE", expectedRevision: firstRevision + 1 }]);
});

test("Task 固定技能导致版本过期时重新核对一次，卸载仍清除可变固定记录", async (t) => {
  const { service, api, calls } = await fixture(t);
  const before = await service.listInstalled();
  const item = before.items.find((entry) => entry.skillId === "skill-a");
  await service.pinTask({ taskId: "task_running", skills: [{ skillId: item.skillId }], expectedRevision: before.revision });
  let refreshed = [];
  const result = await uninstallInstalledSkill(api, item, (items) => { refreshed = items; });
  assert.equal(refreshed.find((entry) => entry.skillId === item.skillId).id, item.id);
  assert.equal(refreshed[0].revision, before.revision + 1);
  assert.deepEqual(calls.map((call) => call.method), ["DELETE", "GET", "DELETE"]);
  assert.deepEqual(installedSkillsAfterUninstall(refreshed, result), (await service.listInstalled()).items);
  assert.equal((await service.inspect()).data.taskPins.length, 0);
});

test("其他页面已卸载同一技能时清理过期列表，不再次删除或报错", async (t) => {
  const { service, api, calls } = await fixture(t);
  const before = await service.listInstalled();
  const item = before.items[0];
  await service.uninstall({ skillId: item.skillId, expectedRevision: before.revision });
  let refreshed = [];
  const result = await uninstallInstalledSkill(api, item, (items) => { refreshed = items; });
  assert.deepEqual(calls.map((call) => call.method), ["DELETE", "GET"]);
  assert.deepEqual(installedSkillsAfterUninstall(refreshed, result), (await service.listInstalled()).items);
  assert.equal(refreshed.length, 1, "保留另一个已安装技能");
});

test("卸载后重新安装的同名技能必须重新确认，旧确认不能删除新安装记录", async (t) => {
  const { service, api, calls, install } = await fixture(t);
  const before = await service.listInstalled();
  const item = before.items[0];
  await service.uninstall({ skillId: item.skillId, expectedRevision: before.revision });
  await install(item.skillId);
  let refreshed = [];
  await assert.rejects(uninstallInstalledSkill(api, item, (items) => { refreshed = items; }), { code: "SKILL_INSTALLATION_CHANGED" });
  const newItem = refreshed.find((entry) => entry.skillId === item.skillId);
  assert.notEqual(newItem.id, item.id);
  assert.equal((await service.listInstalled()).items.length, 2);
  assert.deepEqual(calls.map((call) => call.method), ["DELETE", "GET"]);
  await uninstallInstalledSkill(api, newItem, () => assert.fail("新确认持有当前版本"));
  assert.equal((await service.listInstalled()).items.length, 1);
});

test("卸载失败只对明确的过期/已删除响应恢复，网络和权限错误不盲目重试", async () => {
  for (const code of ["HTTP_ERROR", "FORBIDDEN", "NETWORK_ERROR"]) {
    const error = Object.assign(new Error(code), { code });
    let requests = 0;
    const api = { delete: async () => { requests++; throw error; }, get: async () => assert.fail("不应刷新") };
    await assert.rejects(uninstallInstalledSkill(api, { id: "registry-a", skillId: "skill-a", revision: 1 }, () => assert.fail("不应更新缓存")), (reason) => reason === error);
    assert.equal(requests, 1);
  }
});

test("刷新后仍有并发修改时最多重试一次，确认对象收到已刷新的版本", async () => {
  const item = { id: "registry-a", skillId: "skill-a", revision: 1 };
  const calls = [];
  const api = {
    async delete(_route, { expectedRevision }) {
      calls.push(`delete:${expectedRevision}`);
      throw Object.assign(new Error("数据已被其他操作更新"), { code: "REVISION_CONFLICT" });
    },
    async get() { calls.push("get"); return { data: { revision: 2, items: [{ ...item, revision: 2 }] } }; },
  };
  let refreshed;
  await assert.rejects(uninstallInstalledSkill(api, item, (items) => { refreshed = items; }), { code: "REVISION_CONFLICT" });
  assert.deepEqual(calls, ["delete:1", "get", "delete:2"]);
  assert.equal(refreshed[0].revision, 2);
});

test("404 缺失注册记录也可恢复，但刷新失败不伪装成卸载成功", async () => {
  const item = { id: "registry-a", skillId: "skill-a", revision: 1 };
  const api = {
    async delete() { throw Object.assign(new Error("技能不存在"), { code: "SKILL_REGISTRY_NOT_FOUND" }); },
    async get() { return { data: { revision: 2, items: [] } }; },
  };
  assert.deepEqual(await uninstallInstalledSkill(api, item, () => {}), { skillId: item.skillId, revision: 2 });
  const networkError = new Error("读取列表失败");
  api.get = async () => { throw networkError; };
  await assert.rejects(uninstallInstalledSkill(api, item, () => assert.fail("没有新列表")), (reason) => reason === networkError);
});

test("真实 HTTP 卸载及冲突恢复只移除当前用户安装，保留市场和其他用户副本", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-uninstall-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gateway = await createGatewayServer({ runtimeOptions: { dataRoot: path.join(root, "data") } });
  t.after(() => gateway.close());
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  let requestSequence = 0;
  async function request(route, { token, method = "GET", body, expectedRevision } = {}) {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "POST" ? { "idempotency-key": `uninstall-test-${++requestSequence}` } : {}),
        ...(expectedRevision === undefined ? {} : { "if-match": `"${expectedRevision}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
    return payload;
  }
  const register = async (username) => (await request("/api/auth/register", { method: "POST", body: { username, password: "uninstall-test-password", deviceId: username } })).data.token;
  const admin = await register("uninstall-admin");
  const user = await register("uninstall-user");
  const market = [];
  for (const name of ["卸载回归 A", "卸载回归 B"]) {
    const uploaded = (await request("/api/skill-center/uploads", { token: admin, method: "POST", body: { name, description: "卸载测试", files: [{ path: "SKILL.md", content: `# ${name}\n\n阅读项目说明。` }] } })).data.item;
    const approved = await request(`/api/skill-center/uploads/${uploaded.id}/review`, { token: admin, method: "POST", expectedRevision: uploaded.revision, body: { decision: "approve" } });
    market.push(approved.data.market);
    await request(`/api/skill-center/market/${approved.data.market.id}/install`, { token: user, method: "POST", body: {} });
  }
  await request(`/api/skill-center/market/${market[0].id}/install`, { token: admin, method: "POST", body: {} });
  const calls = [];
  const api = {
    get(route) { calls.push("GET"); return request(route, { token: user }); },
    delete(route, options) { calls.push("DELETE"); return request(route, { ...options, token: user, method: "DELETE" }); },
  };
  const initial = (await request("/api/skill-center/installed", { token: user })).data.items;
  await uninstallInstalledSkill(api, initial[0], () => assert.fail("首个卸载版本有效"));
  let refreshed;
  await uninstallInstalledSkill(api, initial[1], (items) => { refreshed = items; });
  assert.deepEqual(calls, ["DELETE", "DELETE", "GET", "DELETE"]);
  assert.equal(refreshed.length, 1);
  assert.deepEqual((await request("/api/skill-center/installed", { token: user })).data.items, []);
  const adminInstalled = (await request("/api/skill-center/installed", { token: admin })).data.items;
  assert.equal(adminInstalled.length, 1);
  assert.equal(adminInstalled[0].skillId, market[0].skillId);
  for (const item of market) {
    assert.equal((await request(`/api/skill-center/market/${item.id}`, { token: user })).data.id, item.id);
    await assert.rejects(request(`/api/skill-center/installed/${item.skillId}`, { token: user }), { code: "SKILL_REGISTRY_NOT_FOUND" });
  }
});
