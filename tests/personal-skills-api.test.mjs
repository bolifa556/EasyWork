import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayServer } from "../gateway/core/server.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { normalizeNativeSkillFiles, parseNativeSkill } from "../gateway/core/skills/native-package.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-personal-skills-"));
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
    return { status: response.status, ...await response.json() };
  }
  const register = async (username) => {
    const result = await request("/api/auth/register", { method: "POST", body: { username, password: "personal-skills-test-password", deviceId: username } });
    assert.equal(result.status, 200);
    return result.data.token;
  };
  const admin = await register("personal-admin");
  const member = await register("personal-member");
  const other = await register("personal-other");
  assert.deepEqual((await gateway.runtime.auth.resolveSession(member)).actor.roles, []);
  return { request, gateway, admin, member, other };
}

const upload = {
  name: "个人技能",
  description: "只在我的技能库使用",
  files: [
    { path: "SKILL.md", content: "# 个人技能\n\n原始工作步骤。" },
    { path: "references/notes.md", content: "" },
    { path: "scripts/check.py", content: "print('keep this file')\n" },
  ],
};

test("自定义文件名上传、安装及反复编辑均原样保存，只在 Agent 运行视图生成 SKILL.md", async (t) => {
  const { request, gateway, member, admin, other } = await fixture(t);
  const source = "---\r\nname: 应用技能\r\ndescription: 使用应用\r\n---\r\n\r\n# 原始内容\r\n";
  const payload = { name: "应用技能", description: "使用应用", files: [{ path: "create_easyworkSkill.md", content: source }] };
  const created = await request("/api/skill-center/installed", { token: member, method: "POST", body: payload, command: "custom-skill-source" });
  const endpoint = `/api/skill-center/installed/${created.data.registry.skillId}`;
  let detail = (await request(endpoint, { token: member })).data;
  assert.deepEqual(detail.files.map((file) => file.path), ["create_easyworkSkill.md"]);
  assert.equal(detail.primaryFile, "create_easyworkSkill.md");
  assert.equal(detail.files[0].content, source);
  for (const replacement of [source.replace("原始内容", "第一次修改"), source.replace("原始内容", "第二次修改")]) {
    const edited = await request(endpoint, { token: member, method: "PATCH", revision: detail.revision, body: { fileUpdates: [{ path: "create_easyworkSkill.md", content: replacement }] } });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.version.packagePath, created.data.version.packagePath);
    detail = (await request(endpoint, { token: member })).data;
    assert.deepEqual(detail.files.map((file) => file.path), ["create_easyworkSkill.md"]);
    assert.equal(detail.files[0].content, replacement);
  }
  const session = await gateway.runtime.auth.resolveSession(member);
  const root = path.join(actorDataRoot(gateway.runtime.dataRoot, session.actor), path.dirname(created.data.version.packagePath));
  assert.deepEqual(await fs.readdir(path.join(root, "files")), ["create_easyworkSkill.md"]);
  const submission = (await request("/api/skill-center/uploads", { token: admin, method: "POST", body: payload, command: "custom-market-source" })).data.item;
  const market = (await request(`/api/skill-center/uploads/${submission.id}/review`, { token: admin, method: "POST", revision: submission.revision, body: { decision: "approve" } })).data.market;
  await request(`/api/skill-center/market/${market.id}/install`, { token: other, method: "POST", body: {} });
  const installed = (await request(`/api/skill-center/installed/${market.skillId}`, { token: other })).data;
  assert.deepEqual(installed.files.map((file) => file.path), ["create_easyworkSkill.md"]);
  assert.equal(installed.files[0].content, source);
});

test("旧自动生成副本合并回原文件，保留个人编辑、中文元数据和附件，清理可重复执行", async (t) => {
  const { gateway, member } = await fixture(t);
  const { actor } = await gateway.runtime.auth.resolveSession(member);
  const skills = (await gateway.runtime.servicesForActor(actor)).skills;
  const skillId = "legacy-custom-source";
  const manifest = { name: "应用技能", description: "说明应用", entrypoint: "create_easyworkSkill.md", permissions: [] };
  const source = "---\r\nname: 应用技能\r\ndescription: 说明应用\r\n---\r\n\r\n# 征求用户同一\r\n";
  const binary = Buffer.from([0, 255, 1]);
  const legacy = normalizeNativeSkillFiles({ skillId, ...manifest, files: [{ path: manifest.entrypoint, content: Buffer.from(source) }, { path: "assets/data.bin", content: binary }] });
  const edited = legacy.map((file) => file.path === "SKILL.md" ? { ...file, content: Buffer.from(file.content.toString().replace("用户同一", "用户同意")) } : file);
  const installed = await skills.installPackage({ skillId, version: "legacy", manifest, files: edited });
  const before = await skills.getInstalledDetail(skillId);
  const plan = await skills.cleanupStorage();
  assert.deepEqual(plan.restoredSources, [{ skillId, path: manifest.entrypoint }]);
  assert.deepEqual(await skills.getInstalledDetail(skillId), before);
  await skills.cleanupStorage({ dryRun: false });
  const after = await skills.getInstalledDetail(skillId);
  assert.deepEqual(after.files.map((file) => file.path), ["assets/data.bin", manifest.entrypoint]);
  const restored = after.files.find((file) => file.path === manifest.entrypoint).content;
  assert.equal(restored, source.replace("用户同一", "用户同意"));
  assert.equal(parseNativeSkill(restored).metadata.name, manifest.name);
  const root = path.join(actorDataRoot(gateway.runtime.dataRoot, actor), path.dirname(installed.version.packagePath));
  assert.deepEqual(await fs.readFile(path.join(root, "files/assets/data.bin")), binary);
  await assert.rejects(() => fs.access(path.join(root, "files/SKILL.md")), { code: "ENOENT" });
  assert.deepEqual((await skills.cleanupStorage()).restoredSources, []);
  assert.equal((await skills.inspect()).data.versions.length, 1);
});

test("普通用户原位编辑个人技能，保留资源文件和适用范围并清理旧包", async (t) => {
  const { request, gateway, member, other } = await fixture(t);
  const create = () => request("/api/skill-center/installed", { token: member, method: "POST", body: upload, command: "personal-upload-one" });
  const created = await create();
  assert.equal(created.status, 200);
  const { skillId } = created.data.registry;
  const endpoint = `/api/skill-center/installed/${skillId}`;
  const before = (await request(endpoint, { token: member })).data;
  assert.equal(before.name, upload.name);
  assert.equal(before.revision, created.data.revision);
  assert.equal(before.files.find((file) => file.path === "references/notes.md").content, "");
  assert.equal((await create()).data.duplicate, true);
  assert.equal((await request("/api/skill-center/installed", { token: member })).data.items.length, 1);
  assert.equal((await request("/api/skill-center/uploads", { token: member })).data.items.length, 0);
  assert.ok(!(await request("/api/skill-center/market", { token: member })).data.items.some((item) => item.skillId === skillId));
  assert.equal((await request(endpoint, { token: other })).status, 404);
  assert.equal((await request(endpoint, { token: other, method: "PATCH", revision: before.revision, body: { name: "越权" } })).status, 404);
  assert.equal((await request("/api/skill-center/installed", { token: member, method: "POST", command: "personal-upload-one", body: { ...upload, name: "不同内容" } })).status, 409);

  const scope = { mode: "work", serverKind: "compute", allowServers: ["my-server"], denyServers: [], forceEnabled: true };
  assert.equal((await request(`${endpoint}/applicability`, { token: member, method: "PATCH", body: scope })).status, 200);
  const session = await gateway.runtime.auth.resolveSession(member);
  const services = await gateway.runtime.servicesForActor(session.actor);
  const binary = Buffer.from([0, 255, 1, 2, 128]);
  const seeded = await services.skills.uploadVersion({
    skillId, version: "with-binary", expectedRevision: before.revision,
    manifest: created.data.version.manifest,
    files: [...upload.files, { path: "assets/data.bin", content: binary }],
  });
  const oldSelection = [{ knowledge: { key: `skill:${skillId}`, version: `semantic-v1:${seeded.version.version}:${seeded.version.sha256}` } }];
  assert.equal((await services.skills.resolveKnowledgePins(oldSelection)).length, 1);
  const changed = await request(endpoint, { token: member, method: "PATCH", revision: seeded.revision, body: {
    name: "编辑后的个人技能", description: "新的简介",
    fileUpdates: [{ path: "SKILL.md", content: "# 新的步骤\n\n仅执行个人规则。" }, { path: "references/notes.md", content: "新增笔记" }],
  } });
  assert.equal(changed.status, 200);
  const after = (await request(endpoint, { token: member })).data;
  assert.equal(after.name, "编辑后的个人技能");
  assert.equal(after.description, "新的简介");
  assert.deepEqual(after.applicability, scope);
  assert.match(after.files.find((file) => file.path === "SKILL.md").content, /仅执行个人规则/);
  assert.equal(after.files.find((file) => file.path === "scripts/check.py").content, upload.files[2].content);
  await assert.rejects(() => services.skills.resolveKnowledgePins(oldSelection), { code: "SKILL_SELECTED_VERSION_UNAVAILABLE" });
  assert.equal(changed.data.version.id, seeded.version.id);
  assert.equal(changed.data.version.version, seeded.version.version);
  assert.equal(changed.data.version.packagePath, seeded.version.packagePath);
  assert.notEqual(changed.data.version.sha256, seeded.version.sha256);
  const packageFiles = (version) => path.join(actorDataRoot(services.skills.dataRoot, session.actor), path.dirname(version.packagePath), "files");
  assert.deepEqual(await fs.readFile(path.join(packageFiles(changed.data.version), "assets/data.bin")), binary);
  assert.match(await fs.readFile(path.join(packageFiles(seeded.version), "SKILL.md"), "utf8"), /仅执行个人规则/);
  await assert.rejects(() => fs.access(packageFiles(created.data.version)), { code: "ENOENT" });
  const skillRoot = path.join(actorDataRoot(services.skills.dataRoot, session.actor), "skills");
  assert.deepEqual(await fs.readdir(path.join(skillRoot, "packages", skillId)), [seeded.version.version]);
  assert.equal((await services.skills.inspect()).data.versions.length, 1);
  await assert.rejects(() => fs.access(path.join(skillRoot, ".pending-package-edit")), { code: "ENOENT" });

  const parallel = await Promise.all(["第一次编辑", "第二次编辑"].map((name) => request(endpoint, { token: member, method: "PATCH", revision: after.revision, body: { name } })));
  assert.deepEqual(parallel.map((result) => result.status).sort(), [200, 409]);
});

test("个人删除和编辑不改变市场与其他用户副本，拒绝越权和过期写入", async (t) => {
  const { request, gateway, admin, member, other } = await fixture(t);
  const submitted = (await request("/api/skill-center/uploads", { token: admin, method: "POST", command: "market-original", body: upload })).data.item;
  const market = (await request(`/api/skill-center/uploads/${submitted.id}/review`, { token: admin, method: "POST", revision: submitted.revision, command: "market-approve", body: { decision: "approve" } })).data.market;
  const marketPath = `/api/skill-center/market/${market.id}`;
  const endpoint = `/api/skill-center/installed/${market.skillId}`;
  for (const token of [member, other]) assert.equal((await request(`${marketPath}/install`, { token, method: "POST", body: {} })).status, 200);
  const original = (await request(endpoint, { token: member })).data;
  const otherBefore = (await request(endpoint, { token: other })).data;
  const marketBefore = (await request(marketPath, { token: member })).data;
  assert.equal((await request(endpoint, { token: member, method: "PATCH", body: { name: "没有版本" } })).status, 428);
  for (const fileUpdates of [
    [{ path: "../escape.md", content: "outside" }],
    [{ path: "scripts/check.py", content: "overwrite" }],
    [{ path: "missing.md", content: "missing" }],
    [{ path: "SKILL.md", content: "---\nname: [invalid\n---\n" }],
  ]) {
    const result = await request(endpoint, { token: member, method: "PATCH", revision: original.revision, body: { fileUpdates } });
    assert.ok([400, 404].includes(result.status));
    assert.deepEqual((await request(endpoint, { token: member })).data, original);
  }
  assert.equal((await request(endpoint, { token: member, method: "PATCH", revision: original.revision, body: { actorId: "someone-else", name: "invalid" } })).status, 400);
  const updated = await request(endpoint, { token: member, method: "PATCH", revision: original.revision, body: { name: "我的市场副本", fileUpdates: [{ path: "SKILL.md", content: "# 我自己的步骤" }] } });
  assert.equal(updated.status, 200);
  assert.equal((await request(endpoint, { token: member, method: "PATCH", revision: original.revision, body: { name: "过期覆盖" } })).status, 409);
  assert.deepEqual((await request(endpoint, { token: other })).data, otherBefore);
  assert.deepEqual((await request(marketPath, { token: member })).data, marketBefore);
  assert.equal((await request(marketPath, { token: member, method: "PATCH", revision: market.revision, body: { name: "修改市场" } })).status, 403);
  const guest = (await request("/api/auth/guest", { method: "POST", body: { deviceId: "personal-guest" } })).data.token;
  assert.equal((await request("/api/skill-center/installed", { token: guest, method: "POST", command: "guest-upload", body: upload })).status, 401);
  assert.equal((await request(endpoint, { token: guest, method: "PATCH", revision: updated.data.revision, body: { name: "访客编辑" } })).status, 401);
  const session = await gateway.runtime.auth.resolveSession(member);
  const skills = (await gateway.runtime.servicesForActor(session.actor)).skills;
  const packageRoot = path.join(actorDataRoot(skills.dataRoot, session.actor), "skills", "packages", market.skillId);
  assert.equal((await request(endpoint, { token: member, method: "DELETE", revision: updated.data.revision })).status, 200);
  await assert.rejects(() => fs.access(packageRoot), { code: "ENOENT" });
  assert.equal((await request(endpoint, { token: member })).status, 404);
  assert.deepEqual((await request(endpoint, { token: other })).data, otherBefore);
  assert.deepEqual((await request(marketPath, { token: other })).data, marketBefore);
});
