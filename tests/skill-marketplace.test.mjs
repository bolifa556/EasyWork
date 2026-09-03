import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { SkillMarketplaceService, SkillService } from "../gateway/core/skills/index.mjs";
import { normalizeSkillApplicability } from "../gateway/core/skills/applicability.mjs";

function actor(actorId, roles = []) {
  return createActorContext({ actorType: "user", actorId, deviceId: `device_${actorId}`, sessionId: `session_${actorId}`, roles });
}

function ids() {
  let value = 0;
  return (kind) => `${kind}_${++value}`;
}

async function fixture(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-skill-market-"));
  try { return await run(dataRoot); }
  finally { await rm(dataRoot, { recursive: true, force: true }); }
}

const upload = (overrides = {}) => ({
  name: "部署助手",
  description: "按照项目约定完成部署",
  commandId: "upload-deploy-helper",
  files: [
    { path: "SKILL.md", content: "# 部署助手\n\n先检查环境，再执行部署。\n" },
    { path: "references/checklist.md", content: "- 检查变量\n- 验证服务\n" },
  ],
  ...overrides,
});

test("用户上传技能落在全局 data/skills，只有管理员审核通过后才进入市场", async () => {
  await fixture(async (dataRoot) => {
    const user = actor("skill_user");
    const admin = actor("skill_admin", ["admin"]);
    const market = new SkillMarketplaceService({ dataRoot, idFactory: ids() });
    const submitted = await market.submit(user, upload());
    assert.equal(submitted.item.status, "pending");
    assert.equal((await market.listMarket()).items.length, 0);
    assert.equal((await market.listSubmissions(user)).items[0].name, "部署助手");
    assert.equal((await market.listSubmissions(actor("other_user"))).items.length, 0);

    const detail = await market.getSubmission(admin, submitted.item.id);
    assert.equal(detail.files.length, 2);
    assert.match(detail.files.find((file) => file.path === "SKILL.md").content, /先检查环境/);
    const reviewed = await market.review(admin, submitted.item.id, { decision: "approve", expectedRevision: submitted.item.revision });
    assert.equal(reviewed.item.status, "approved");
    const listed = await market.listMarket();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].name, "部署助手");

    const index = JSON.parse(await readFile(path.join(dataRoot, "skills", "index.json"), "utf8"));
    assert.equal(index.data.submissions[0].uploaderId, user.actorId);
    assert.equal(index.data.market[0].submissionId, submitted.item.id);
  });
});

test("市场安装复制到用户 skills 目录，网页 Agent 只在该用户已安装技能中读取正文", async () => {
  await fixture(async (dataRoot) => {
    const uploader = actor("market_uploader");
    const admin = actor("market_admin", ["admin"]);
    const consumer = actor("market_consumer");
    const other = actor("market_other");
    const market = new SkillMarketplaceService({ dataRoot, idFactory: ids() });
    const submitted = await market.submit(uploader, upload());
    const reviewed = await market.review(admin, submitted.item.id, { decision: "approve", expectedRevision: submitted.item.revision });
    const consumerSkills = new SkillService({ dataRoot, actor: consumer, idFactory: ids(), authorizeTask: async () => true });
    const installed = await market.install(consumer, consumerSkills, reviewed.market.id);
    assert.equal(installed.installed, true);
    assert.equal((await consumerSkills.listInstalled()).items[0].name, "部署助手");
    assert.match((await consumerSkills.searchContext({ query: "部署助手" }))[0].files[0].content, /先检查环境/);
    assert.equal((await market.listMarket({ installedSkillIds: [installed.skillId] })).items[0].installed, true);

    const otherSkills = new SkillService({ dataRoot, actor: other, idFactory: ids(), authorizeTask: async () => true });
    assert.deepEqual(await otherSkills.searchContext({ query: "执行部署" }), []);
    await access(path.join(actorDataRoot(dataRoot, consumer), "skills", "packages", installed.skillId));
    await assert.rejects(() => access(path.join(actorDataRoot(dataRoot, other), "skills", "packages", installed.skillId)));
  });
});

test("管理员可编辑和删除市场技能，拒绝的上传不会进入市场", async () => {
  await fixture(async (dataRoot) => {
    const user = actor("review_user");
    const admin = actor("review_admin", ["admin"]);
    const market = new SkillMarketplaceService({ dataRoot, idFactory: ids() });
    const rejected = await market.submit(user, upload({ commandId: "reject-me" }));
    await market.review(admin, rejected.item.id, { decision: "reject", expectedRevision: rejected.item.revision });
    assert.equal((await market.listMarket()).items.length, 0);

    const approved = await market.submit(user, upload({ name: "代码检查", commandId: "approve-me" }));
    const review = await market.review(admin, approved.item.id, { decision: "approve", expectedRevision: approved.item.revision });
    const changed = await market.updateMarket(admin, review.market.id, { name: "代码审查", description: "检查项目代码", expectedRevision: review.market.revision });
    assert.equal(changed.item.name, "代码审查");
    const contentChanged = await market.updateMarket(admin, review.market.id, {
      name: changed.item.name,
      description: changed.item.description,
      fileUpdates: [{ path: "SKILL.md", content: "# 代码审查\n\n更新后的 Markdown 正文。\n" }],
      expectedRevision: changed.item.revision,
    });
    const detail = await market.getMarket(review.market.id);
    assert.match(detail.files.find((file) => file.path === "SKILL.md").content, /更新后的 Markdown 正文/);
    assert.match(detail.files.find((file) => file.path === "references\/checklist.md").content, /检查变量/);
    await assert.rejects(() => market.updateMarket(user, review.market.id, { name: "越权", description: "", expectedRevision: contentChanged.item.revision }), (error) => error?.code === "ROLE_REQUIRED");
    await market.deleteMarket(admin, review.market.id, { expectedRevision: contentChanged.item.revision });
    assert.equal((await market.listMarket()).items.length, 0);
  });
});

test("市场范围可单独保存，多个技能和各用户的安装配置相互独立", async () => {
  await fixture(async (dataRoot) => {
    const admin = actor("scope_admin", ["admin"]);
    const firstUser = actor("scope_first");
    const nextUser = actor("scope_next");
    const market = new SkillMarketplaceService({ dataRoot, idFactory: ids() });
    const firstSkills = new SkillService({ dataRoot, actor: firstUser, idFactory: ids(), authorizeTask: async () => true });
    const nextSkills = new SkillService({ dataRoot, actor: nextUser, idFactory: ids(), authorizeTask: async () => true });
    const approved = [];
    for (const suffix of ["A", "B"]) {
      const submission = await market.submit(admin, upload({ name: `独立技能 ${suffix}`, commandId: `independent-${suffix}` }));
      approved.push((await market.review(admin, submission.item.id, { decision: "approve", expectedRevision: submission.item.revision })).market);
    }
    const [skillA, skillB] = approved;
    const originalB = await market.getMarket(skillB.id);
    const firstScope = normalizeSkillApplicability({ mode: "work", serverKind: "compute", allowServers: ["107.ustc.edu.cn"], forceEnabled: true });
    const secondScope = normalizeSkillApplicability({ mode: "all", serverKind: "standard", denyServers: ["server-blocked"] });
    const changedA = await market.updateMarket(admin, skillA.id, { applicability: firstScope, expectedRevision: skillA.revision });
    assert.equal(changedA.item.name, skillA.name);
    assert.equal(changedA.item.description, skillA.description);
    assert.deepEqual((await market.getMarket(skillA.id)).files, (await market.getMarket(skillB.id)).files);
    assert.deepEqual(await market.getMarket(skillB.id), originalB);
    await market.updateMarket(admin, skillB.id, { applicability: secondScope, expectedRevision: skillB.revision });
    await market.install(firstUser, firstSkills, skillA.id);
    await market.install(firstUser, firstSkills, skillB.id);
    assert.deepEqual((await firstSkills.getInstalledDetail(skillA.skillId)).applicability, firstScope);
    assert.deepEqual((await firstSkills.getInstalledDetail(skillB.skillId)).applicability, secondScope);

    const personalScope = normalizeSkillApplicability({ mode: "all", allowServers: ["my-server"], denyServers: ["blocked-host"], forceEnabled: true });
    await firstSkills.updateApplicability(skillA.skillId, personalScope);
    assert.deepEqual((await market.getMarket(skillA.id)).applicability, firstScope);
    assert.deepEqual((await firstSkills.getInstalledDetail(skillB.skillId)).applicability, secondScope);
    const nextDefault = normalizeSkillApplicability({ mode: "chat" });
    const latest = await market.updateMarket(admin, skillA.id, { applicability: nextDefault, expectedRevision: changedA.item.revision });
    assert.deepEqual((await firstSkills.getInstalledDetail(skillA.skillId)).applicability, personalScope);
    await market.install(firstUser, firstSkills, skillA.id);
    assert.deepEqual((await firstSkills.getInstalledDetail(skillA.skillId)).applicability, personalScope);
    await market.install(nextUser, nextSkills, skillA.id);
    assert.deepEqual((await nextSkills.getInstalledDetail(skillA.skillId)).applicability, nextDefault);
    assert.deepEqual((await firstSkills.getInstalledDetail(skillB.skillId)).applicability, secondScope);
    await assert.rejects(() => market.updateMarket(admin, skillA.id, { name: "", expectedRevision: latest.item.revision }));
    assert.equal((await market.getMarket(skillA.id)).name, skillA.name);

    await firstSkills.uninstall({ skillId: skillA.skillId, expectedRevision: (await firstSkills.inspect()).revision });
    await market.install(firstUser, firstSkills, skillA.id);
    assert.deepEqual((await firstSkills.getInstalledDetail(skillA.skillId)).applicability, nextDefault);
  });
});
