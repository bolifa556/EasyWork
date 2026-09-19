import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActorContext } from "../gateway/core/actor.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { atomicWriteJson } from "../gateway/core/repository.mjs";
import { SkillMarketplaceService, SkillService } from "../gateway/core/skills/index.mjs";
import { recoverSkillPackageEdit, replaceSkillPackage, removeSkillDirectory } from "../gateway/core/skills/package-storage.mjs";
import { cleanupSkillStorage } from "../scripts/cleanup-skill-storage.mjs";

const actor = (actorId, roles = []) => createActorContext({ actorType: "user", actorId, deviceId: "test-device", sessionId: "test-session", roles });
const admin = actor("admin", ["admin"]);
const upload = (name = "技能") => ({ name, description: "技能简介", commandId: `upload-${name}`, files: [{ path: "SKILL.md", content: "# 原始技能" }, { path: "references/guide.md", content: "原始附件" }] });
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const missing = (file) => assert.rejects(() => fs.access(file), { code: "ENOENT" });

async function fixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-skill-cleanup-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const market = new SkillMarketplaceService({ dataRoot });
  const state = path.join(dataRoot, "skills/index.json");
  const publish = async (name) => {
    const submitted = await market.submit(admin, upload(name));
    return (await market.review(admin, submitted.item.id, { decision: "approve", expectedRevision: submitted.item.revision })).market;
  };
  return { dataRoot, market, state, publish };
}

test("市场编辑复用原包并同步上传索引，删除后不留文件或重复上传副本", async (t) => {
  const { dataRoot, market, state, publish } = await fixture(t);
  const item = await publish("原位编辑");
  const before = (await readJson(state)).data.market[0];
  assert.equal((await market.submit(admin, { ...upload("原位编辑"), commandId: "retry-with-another-key" })).duplicate, true);
  const updated = await market.updateMarket(admin, item.id, { expectedRevision: item.revision, fileUpdates: [{ path: "SKILL.md", content: "# 编辑后" }] });
  const store = (await readJson(state)).data;
  assert.equal(store.market[0].packageId, before.packageId);
  assert.notEqual(store.market[0].packageSha256, before.packageSha256);
  assert.equal(store.submissions[0].packageId, before.packageId);
  assert.equal(store.submissions[0].packageSha256, store.market[0].packageSha256);
  assert.match((await market.getSubmission(admin, store.submissions[0].id)).files.find((file) => file.path === "SKILL.md").content, /编辑后/);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, "skills/packages")), [before.packageId]);
  await missing(path.join(dataRoot, "skills/.pending-package-edit"));
  await market.deleteMarket(admin, item.id, { expectedRevision: updated.item.revision });
  assert.deepEqual((await readJson(state)).data, { submissions: [], market: [] });
  assert.deepEqual(await fs.readdir(path.join(dataRoot, "skills/packages")), []);
});

test("内置技能更新复用目录，管理员编辑和删除在重启后仍然有效", async (t) => {
  const { dataRoot } = await fixture(t);
  let content = "# 内置第一版";
  const prompts = { builtinSkills: async () => [{ id: "market_skill_builtin", skillId: "skill_builtin", name: "内置技能", description: "", files: [{ path: "SKILL.md", content }] }] };
  let market = new SkillMarketplaceService({ dataRoot, prompts });
  await market.ensureBuiltins();
  const packages = await fs.readdir(path.join(dataRoot, "skills/packages"));
  content = "# 内置第二版";
  await market.ensureBuiltins();
  assert.deepEqual(await fs.readdir(path.join(dataRoot, "skills/packages")), packages);
  const current = await market.getMarket("market_skill_builtin");
  assert.match(current.files[0].content, /第二版/);
  const edited = await market.updateMarket(admin, current.id, { expectedRevision: current.revision, fileUpdates: [{ path: "SKILL.md", content: "# 管理员编辑" }] });
  market = new SkillMarketplaceService({ dataRoot, prompts });
  await market.ensureBuiltins();
  assert.match((await market.getMarket(current.id)).files[0].content, /管理员编辑/);
  await market.deleteMarket(admin, current.id, { expectedRevision: edited.item.revision });
  market = new SkillMarketplaceService({ dataRoot, prompts });
  await market.ensureBuiltins();
  assert.deepEqual((await market.listMarket()).items, []);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, "skills/packages")), []);
});

test("清理已删除、旧版及未完成包；待审核、被拒绝和有效技能不受影响", async (t) => {
  const { dataRoot, market, state, publish } = await fixture(t);
  const deleted = await publish("已删除");
  const active = await publish("有效");
  await market.submit(admin, upload("待审核"));
  const rejected = await market.submit(admin, upload("被拒绝"));
  await market.review(admin, rejected.item.id, { decision: "reject", expectedRevision: rejected.item.revision });
  const envelope = await readJson(state);
  const original = envelope.data.market.find((item) => item.id === active.id);
  const oldRoot = path.join(dataRoot, "skills/packages", original.packageId);
  await fs.cp(oldRoot, path.join(dataRoot, "skills/packages/skill_package_old_edit"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "skills/packages/skill_package_unfinished/files"), { recursive: true });
  envelope.data.market = envelope.data.market.filter((item) => item.id !== deleted.id);
  await atomicWriteJson(state, envelope);
  const indexBefore = await fs.readFile(state, "utf8");
  const filesBefore = await fs.readdir(path.join(dataRoot, "skills/packages"));
  const plan = await market.cleanupStorage();
  assert.equal(plan.removedPackages.length, 3);
  assert.deepEqual(plan.removedSubmissions.map((item) => item.name), ["已删除"]);
  assert.equal(await fs.readFile(state, "utf8"), indexBefore);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, "skills/packages")), filesBefore);
  const result = await market.cleanupStorage({ dryRun: false });
  assert.deepEqual(result.removedPackages, plan.removedPackages);
  assert.equal((await readJson(state)).data.submissions.length, 3);
  assert.equal((await market.getMarket(active.id)).name, "有效");
  assert.equal((await market.getSubmission(admin, rejected.item.id)).status, "rejected");
  assert.equal((await market.cleanupStorage()).removedPackages.length, 0);
});

test("个人清理移除无引用包，保留当前附件和其他账户", async (t) => {
  const { dataRoot } = await fixture(t);
  const owner = actor("owner");
  const other = actor("other");
  const skills = new SkillService({ dataRoot, actor: owner, authorizeTask: async () => true });
  const otherSkills = new SkillService({ dataRoot, actor: other, authorizeTask: async () => true });
  const input = { skillId: "skill-one", manifest: { name: "技能", description: "", entrypoint: "SKILL.md", permissions: [] }, files: upload().files };
  const installed = await skills.installPackage(input);
  await otherSkills.installPackage(input);
  const obsolete = path.join(actorDataRoot(dataRoot, owner), "skills/packages/skill-one/obsolete");
  await fs.mkdir(obsolete, { recursive: true });
  await fs.writeFile(path.join(obsolete, "old"), "obsolete");
  assert.deepEqual((await skills.cleanupStorage()).removedPackages, ["packages/skill-one/obsolete"]);
  await fs.access(obsolete);
  await skills.cleanupStorage({ dryRun: false });
  await assert.rejects(() => fs.access(obsolete), { code: "ENOENT" });
  assert.deepEqual((await skills.inspect()).data.skills, [installed.skill]);
  assert.equal((await otherSkills.listInstalled()).items.length, 1);
});
test("清理前校验所有保留包，损坏时不删除任何账户的数据", async (t) => {
  const { dataRoot, state, publish } = await fixture(t);
  await publish("有效");
  const orphan = path.join(dataRoot, "skills/packages/skill_package_orphan");
  await fs.mkdir(orphan, { recursive: true });
  const owner = actor("corrupt-owner");
  const skills = new SkillService({ dataRoot, actor: owner, authorizeTask: async () => false });
  const installed = await skills.createInstalled({ ...upload("个人"), commandId: "personal" });
  const file = path.join(actorDataRoot(dataRoot, owner), path.dirname(installed.skill.packagePath), "files/SKILL.md");
  await fs.writeFile(file, "damaged");
  const before = await fs.readFile(state, "utf8");
  await assert.rejects(() => cleanupSkillStorage({ dataRoot, dryRun: false }), { code: "SKILL_PACKAGE_FILE_CORRUPT" });
  await fs.access(orphan);
  assert.equal(await fs.readFile(state, "utf8"), before);
});

test("原位更新提交失败会恢复原包，成功后清除临时事务目录", async (t) => {
  const { dataRoot } = await fixture(t);
  const root = path.join(dataRoot, "skills"), relativeRoot = "packages/skill_package_transaction";
  const target = path.join(root, relativeRoot);
  const previousHash = "a".repeat(64), nextHash = "b".repeat(64);
  let expected = previousHash;
  await fs.mkdir(path.join(target, "files"), { recursive: true });
  await fs.writeFile(path.join(target, "files/SKILL.md"), "original");
  await atomicWriteJson(path.join(target, "package.json"), { sha256: previousHash });
  const options = { root, relativeRoot, descriptor: { sha256: nextHash }, files: [{ path: "SKILL.md", content: Buffer.from("updated") }], readExpectedHash: async () => expected };
  await assert.rejects(() => replaceSkillPackage({ ...options, commit: async () => { throw new Error("index unavailable"); } }), /index unavailable/);
  assert.equal(await fs.readFile(path.join(target, "files/SKILL.md"), "utf8"), "original");
  await missing(path.join(root, ".pending-package-edit"));
  const rename = fs.rename.bind(fs);
  let blockedRenames = 0;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (source === target && blockedRenames < 2) {
      blockedRenames += 1;
      throw Object.assign(new Error("temporarily held by Windows indexer"), { code: "EPERM" });
    }
    return rename(source, destination);
  });
  await replaceSkillPackage({ ...options, commit: async () => { expected = nextHash; } });
  assert.equal(blockedRenames, 2);
  assert.equal(await fs.readFile(path.join(target, "files/SKILL.md"), "utf8"), "updated");
  await missing(path.join(root, ".pending-package-edit"));
});

test("重启按已提交索引恢复中断编辑，不留下旧包", async (t) => {
  const { dataRoot } = await fixture(t);
  for (const committed of [false, true]) {
    const root = path.join(dataRoot, committed ? "committed" : "uncommitted");
    const relativeRoot = "packages/skill_package_recovery";
    const target = path.join(root, relativeRoot), transaction = path.join(root, ".pending-package-edit");
    const previousHash = "a".repeat(64), nextHash = "b".repeat(64);
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(transaction, "previous"), { recursive: true });
    await atomicWriteJson(path.join(target, "package.json"), { sha256: nextHash });
    await atomicWriteJson(path.join(transaction, "previous/package.json"), { sha256: previousHash });
    await atomicWriteJson(path.join(transaction, "intent.json"), { relativeRoot, previousHash, nextHash });
    const expected = committed ? nextHash : previousHash;
    await recoverSkillPackageEdit(root, async () => expected);
    assert.equal((await readJson(path.join(target, "package.json"))).sha256, expected);
    await missing(transaction);
  }
});

test("技能清理拒绝越界目录和指向其他目录的链接", async (t) => {
  const { dataRoot } = await fixture(t);
  const root = path.join(dataRoot, "skills"), outside = path.join(dataRoot, "unrelated");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  await assert.rejects(() => removeSkillDirectory(root, "../unrelated"), { code: "SKILL_STORAGE_PATH_ESCAPE" });
  await assert.rejects(() => removeSkillDirectory(root, "."), { code: "SKILL_STORAGE_PATH_ESCAPE" });
  await fs.symlink(outside, path.join(root, "linked"), "junction");
  await assert.rejects(() => removeSkillDirectory(root, "linked"), { code: "SKILL_STORAGE_LINK_UNSAFE" });
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
});
