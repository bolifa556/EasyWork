import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActorContext } from "../gateway/core/actor.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { SkillService } from "../gateway/core/skills/service.mjs";

const digest = (content) => crypto.createHash("sha256").update(content).digest("hex");
async function fixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-skill-migration-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const actor = createActorContext({ actorType: "user", actorId: "owner", deviceId: "test", sessionId: "test", roles: [] });
  const root = path.join(actorDataRoot(dataRoot, actor), "skills");
  const manifest = { name: "我的技能", description: "个人修改的说明", entrypoint: "SKILL.md", permissions: [] };
  const files = [{ path: "SKILL.md", content: Buffer.from("# 用户当前部署的内容\n完整保留\n") }, { path: "assets/data.bin", content: Buffer.from([0, 255, 1, 4]) }];
  const records = [];
  // The active package need not have the largest release label or latest timestamp.
  for (const [label, id, content] of [["content", "selected", files], ["newer", "unused", [{ path: "SKILL.md", content: Buffer.from("不能切换到这个包") }]]]) {
    const hash = crypto.createHash("sha256");
    const feed = (value) => { const bytes = Buffer.from(value); hash.update(bytes.length + ":"); hash.update(bytes); };
    feed("guide"); feed(label); feed(JSON.stringify(manifest));
    for (const file of content) { feed(file.path); feed(file.content); }
    const sha256 = hash.digest("hex");
    const packagePath = `skills/packages/guide/${label}/package.json`;
    const directory = path.join(actorDataRoot(dataRoot, actor), path.dirname(packagePath));
    for (const file of content) {
      await fs.mkdir(path.dirname(path.join(directory, "files", file.path)), { recursive: true });
      await fs.writeFile(path.join(directory, "files", file.path), file.content);
    }
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ schemaVersion: 1, skillId: "guide", version: label, sha256, manifest,
      files: content.map((file) => ({ path: file.path, size: file.content.length, sha256: digest(file.content) })) }));
    records.push({ id, actorId: actor.actorId, skillId: "guide", version: label, sha256, packagePath, manifest, installedAt: "2026-08-01T00:00:00.000Z" });
  }
  const store = { schemaVersion: 1, revision: 7, updatedAt: "2026-08-02T00:00:00.000Z", data: {
    versions: records, taskPins: [], registries: [{ id: "registry-guide", actorId: actor.actorId, skillId: "guide", activeVersionId: "selected", displayName: manifest.name,
      description: manifest.description, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" }],
  } };
  await fs.writeFile(path.join(root, "index.json"), JSON.stringify(store));
  const applicability = JSON.stringify({ schemaVersion: 1, revision: 2, data: { actorId: actor.actorId, items: [{ skillId: "guide",
    applicability: { mode: "work", serverKind: "compute", allowServers: ["own-server"], denyServers: [], forceEnabled: true }, updatedAt: "2026-08-02T00:00:00.000Z" }] } });
  await fs.writeFile(path.join(root, "applicability.json"), applicability);
  const service = () => new SkillService({ dataRoot, actor, authorizeTask: async () => true });
  return { root, records, files, applicability, service };
}

test("旧技能索引迁移只保留用户正在使用的内容，附件和范围不变，重启可重入", async (t) => {
  const f = await fixture(t);
  const installed = await f.service().listInstalled();
  assert.equal(installed.items.length, 1);
  assert.equal(installed.items[0].name, "我的技能");
  assert.equal(installed.items[0].applicability.forceEnabled, true);
  assert.equal(Object.hasOwn(installed.items[0], "version"), false);
  assert.equal(await fs.readFile(path.join(f.root, "applicability.json"), "utf8"), f.applicability);
  const store = await f.service().inspect();
  assert.deepEqual(Object.keys(store.data), ["skills"]);
  assert.equal(store.data.skills.length, 1);
  assert.equal(store.data.skills[0].id, "registry-guide");
  for (const file of f.files) assert.deepEqual(await fs.readFile(path.join(f.root, "packages/guide/.installed/files", file.path)), file.content);
  assert.deepEqual(await fs.readdir(path.join(f.root, "packages/guide")), [".installed"]);
  assert.deepEqual(await f.service().inspect(), store);
  const oldChoice = [{ knowledge: { key: "skill:guide", version: "semantic-v1:content:" + f.records[0].sha256 } }];
  assert.deepEqual(await f.service().resolveSkills(oldChoice), [{ skillId: "guide", sha256: store.data.skills[0].sha256 }]);
});

test("迁移前验证源文件，损坏时保留旧索引和所有包", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.root, "index.json"));
  await fs.writeFile(path.join(f.root, "packages/guide/content/files/SKILL.md"), "changed outside the skill editor");
  await assert.rejects(() => f.service().listInstalled(), { code: "SKILL_PACKAGE_FILE_CORRUPT" });
  assert.deepEqual(await fs.readFile(path.join(f.root, "index.json")), index);
  assert.deepEqual((await fs.readdir(path.join(f.root, "packages/guide"))).sort(), ["content", "newer"]);
});

test("清理预览不会迁移或删除旧安装内容", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.root, "index.json"));
  const preview = await f.service().cleanupStorage({ dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.removedPackages, ["packages/guide/newer"]);
  assert.deepEqual(await fs.readFile(path.join(f.root, "index.json")), index);
  assert.equal(await fs.readFile(path.join(f.root, "applicability.json"), "utf8"), f.applicability);
  assert.deepEqual((await fs.readdir(path.join(f.root, "packages/guide"))).sort(), ["content", "newer"]);
});
