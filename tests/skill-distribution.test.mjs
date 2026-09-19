import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayServer } from "../gateway/core/server.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";

async function fixture(t) {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-skill-distribution-"));
  const dataRoot = path.join(testRoot, "data");
  let gateway, origin;
  async function restart() {
    if (gateway) await gateway.close();
    gateway = await createGatewayServer({ runtimeOptions: { dataRoot } });
    const address = await gateway.start({ host: "127.0.0.1", port: 0 });
    origin = `http://127.0.0.1:${address.port}`;
  }
  t.after(async () => { if (gateway) await gateway.close(); await fs.rm(testRoot, { recursive: true, force: true }); });
  await restart();
  async function request(route, { session, method = "GET", body, revision, command } = {}) {
    const response = await fetch(origin + route, { method, headers: {
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(revision === undefined ? {} : { "if-match": `"${revision}"` }),
      ...(command ? { "idempotency-key": command } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() };
  }
  const register = async (username) => {
    const result = await request("/api/auth/register", { method: "POST", body: { username, password: "skill-distribution-test-password", deviceId: username } });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  const admin = await register("distribution-admin");
  const owner = await register("distribution-owner");
  const empty = await register("distribution-empty");
  const submitted = (await request("/api/skill-center/uploads", { session: admin, method: "POST", command: "publish-default", body: {
    name: "共享应用技能", description: "已部署应用的使用方法", files: [{ path: "SKILL.md", content: "# 初始运行方式" }, { path: "notes.md", content: "保留附件" }],
  } })).data.item;
  const published = await request(`/api/skill-center/uploads/${submitted.id}/review`, { session: admin, method: "POST", revision: submitted.revision, body: { decision: "approve" } });
  assert.equal(published.status, 200);
  const market = published.data.market;
  return { dataRoot, get gateway() { return gateway; }, restart, request, register, admin, owner, empty, market,
    marketPath: `/api/skill-center/market/${market.id}`, personalPath: `/api/skill-center/installed/${market.skillId}` };
}

test("市场简介随安装交给各用户，目录直接复用并忽略旧的个人发现简介缓存", async (t) => {
  const f = await fixture(t);
  for (const user of [f.owner, f.empty]) {
    assert.equal((await f.request(`${f.marketPath}/install`, { session: user, method: "POST", body: {} })).status, 200);
    const session = await f.gateway.runtime.auth.resolveSession(user.token);
    const services = await f.gateway.runtime.servicesForActor(session.actor);
    const cacheFile = path.join(actorDataRoot(f.dataRoot, session.actor), "skills/discovery.json");
    await fs.writeFile(cacheFile, "obsolete per-user discovery cache");
    const catalog = await services.skills.listInstalledKnowledge();
    assert.equal(catalog.items[0].description, f.market.description);
    assert.equal(Object.hasOwn(catalog.items[0], "discoveryDescription"), false);
    const prompt = await f.gateway.runtime.prompts.skillCatalog(catalog.items);
    assert.match(JSON.stringify(prompt), /已部署应用的使用方法/);
  }
});

test("开启全体部署给现有和新注册用户安装，已有个人修改和附件保持原样", async (t) => {
  const f = await fixture(t);
  const { request, owner, admin, marketPath, personalPath } = f;
  await request(`${marketPath}/install`, { session: owner, method: "POST", body: {} });
  const original = (await request(personalPath, { session: owner })).data;
  const edited = await request(personalPath, { session: owner, method: "PATCH", revision: original.revision, body: { name: "我的独立技能", fileUpdates: [{ path: "SKILL.md", content: "# 我的专用运行方式" }] } });
  assert.equal(edited.status, 200);
  const before = (await request(personalPath, { session: owner })).data;
  const ownerIndex = path.join(actorDataRoot(f.dataRoot, owner.actor), "skills/index.json");
  const indexBefore = await fs.readFile(ownerIndex, "utf8");
  const enabled = await request(marketPath, { session: admin, method: "PATCH", revision: f.market.revision, body: { deployToAllUsers: true } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.item.deployToAllUsers, true);
  assert.deepEqual(enabled.data.deployment, { installed: 2, skipped: 1, failed: 0 });
  assert.deepEqual((await request(personalPath, { session: owner })).data, before);
  assert.equal(await fs.readFile(ownerIndex, "utf8"), indexBefore);
  assert.equal((await request(personalPath, { session: f.empty })).status, 200);
  const newcomer = await f.register("distribution-new");
  // Verify registration itself installs the package, before opening any page.
  const newIndex = JSON.parse(await fs.readFile(path.join(actorDataRoot(f.dataRoot, newcomer.actor), "skills/index.json"), "utf8"));
  assert.equal(newIndex.data.skills[0].skillId, f.market.skillId);
  assert.equal(newIndex.data.skills.length, 1);
  const latest = await request(marketPath, { session: admin, method: "PATCH", revision: enabled.data.item.revision, body: { fileUpdates: [{ path: "SKILL.md", content: "# 市场更新后的运行方式" }] } });
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.data.deployment, { installed: 0, skipped: 4, failed: 0 });
  assert.deepEqual((await request(personalPath, { session: owner })).data, before);
  const later = await f.register("distribution-later");
  assert.match((await request(personalPath, { session: later })).data.files.find((file) => file.path === "SKILL.md").content, /市场更新后/);
  const disabled = await request(marketPath, { session: admin, method: "PATCH", revision: latest.data.item.revision, body: { deployToAllUsers: false } });
  assert.equal(disabled.status, 200);
  const afterDisable = await f.register("distribution-after-disable");
  assert.equal((await request("/api/skill-center/installed", { session: afterDisable })).data.items.length, 0);
  assert.equal((await request(personalPath, { session: later })).status, 200);
});

test("全体部署仅限管理员市场设置，拒绝非法值和过期写入，访客不安装", async (t) => {
  const f = await fixture(t);
  for (const value of ["true", 1, null, {}]) assert.equal((await f.request(f.marketPath, { session: f.admin, method: "PATCH", revision: f.market.revision, body: { deployToAllUsers: value } })).status, 400);
  assert.equal((await f.request(f.marketPath, { session: f.owner, method: "PATCH", revision: f.market.revision, body: { deployToAllUsers: true } })).status, 403);
  assert.equal((await f.request(f.marketPath, { session: f.admin, method: "PATCH", revision: 0, body: { deployToAllUsers: true } })).status, 409);
  assert.equal((await f.request(f.marketPath, { session: f.admin })).data.deployToAllUsers, false);
  const enabled = await f.request(f.marketPath, { session: f.admin, method: "PATCH", revision: f.market.revision, body: { deployToAllUsers: true } });
  assert.equal(enabled.status, 200);
  const personal = (await f.request(f.personalPath, { session: f.owner })).data;
  assert.equal((await f.request(f.personalPath, { session: f.owner, method: "PATCH", revision: personal.revision, body: { deployToAllUsers: false } })).status, 400);
  const guest = (await f.request("/api/auth/guest", { method: "POST", body: { deviceId: "distribution-guest" } })).data;
  assert.equal((await f.request("/api/skill-center/installed", { session: guest })).data.items.length, 0);
  await f.request(f.marketPath, { session: f.admin, method: "DELETE", revision: enabled.data.item.revision });
  const afterDelete = await f.register("distribution-after-delete");
  assert.equal((await f.request("/api/skill-center/installed", { session: afterDelete })).data.items.length, 0);
  assert.equal((await f.request(f.personalPath, { session: f.owner })).status, 200);
});

test("重启补完中断的全体部署，已完成的分发不会重复安装或撤销个人卸载", async (t) => {
  const f = await fixture(t);
  f.gateway.runtime.skillMarketplace.onDeployment = null;
  const enabled = await f.request(f.marketPath, { session: f.admin, method: "PATCH", revision: f.market.revision, body: { deployToAllUsers: true } });
  assert.equal(enabled.status, 200);
  await assert.rejects(() => fs.access(path.join(actorDataRoot(f.dataRoot, f.empty.actor), "skills/index.json")), { code: "ENOENT" });
  await f.restart();
  const installed = (await f.request(f.personalPath, { session: f.empty })).data;
  assert.equal(installed.name, f.market.name);
  const ownerBefore = (await f.request(f.personalPath, { session: f.owner })).data;
  assert.equal((await f.request(f.personalPath, { session: f.empty, method: "DELETE", revision: installed.revision })).status, 200);
  await f.restart();
  assert.equal((await f.request("/api/skill-center/installed", { session: f.empty })).data.items.length, 0);
  assert.deepEqual((await f.request(f.personalPath, { session: f.owner })).data, ownerBefore);
});
