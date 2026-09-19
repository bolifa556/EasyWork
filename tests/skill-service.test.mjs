import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { isAutomaticSkillApplicable } from "../gateway/core/skills/applicability.mjs";
import { SkillService } from "../gateway/core/skills/index.mjs";

test("旧选择只保留技能身份，更新后读取当前安装内容，不受旧标签或哈希约束", async () => {
  await fixture(async (dataRoot) => {
    const service = new SkillService(serviceOptions(dataRoot, actor()));
    const one = await service.uploadPackage(skillInput());
    const selected = { knowledge: { key: "skill:shell-helper", version: "semantic-v1:old:" + one.skill.sha256 } };
    const two = await service.uploadPackage(skillInput({ expectedRevision: one.revision, files: [
      { path: "scripts/main.mjs", content: "current installed content" }, { path: "README.md", content: "updated" },
    ] }));
    assert.deepEqual(await service.resolveSkills([selected, { knowledge: { key: "skill:shell-helper", version: "stale" } }]), [{ skillId: "shell-helper", sha256: two.skill.sha256 }]);
    const plan = await service.createDeploymentPlan({ taskId: "task_a", pins: [{ skillId: "shell-helper", version: "missing", sha256: one.skill.sha256 }] });
    assert.equal(plan.skills[0].sha256, two.skill.sha256);
    assert.equal(Object.hasOwn(plan.skills[0], "version"), false);
    assert.equal((await service.inspect()).data.skills.length, 1);
  });
});
function actor(actorType = "user", actorId = "skill_owner") {
  return createActorContext({
    actorType,
    actorId,
    deviceId: `device_${actorId}`,
    sessionId: `session_${actorId}`,
    roles: [],
  });
}

function idFactory() {
  let value = 0;
  return (kind) => `${kind}_${++value}`;
}

function serviceOptions(dataRoot, currentActor, overrides = {}) {
  return {
    dataRoot,
    actor: currentActor,
    idFactory: idFactory(),
    authorizeTask: async ({ taskId }) => taskId !== "task_forbidden",
    ...overrides,
  };
}

test("Skill 发现只按显式适用范围匹配服务器和调度器", () => {
  const slurmSkill = {
    name: "本科生算力平台使用规范",
    description: "适用于 USTC 登录节点、Slurm 队列和 GPU 作业。",
    applicability: { mode: "work", serverKind: "compute", allowServers: ["107.ustc.edu.cn"] },
  };
  assert.equal(isAutomaticSkillApplicable({ skill: slurmSkill, serverName: "reta服务器", scheduler: "none" }), false);
  assert.equal(isAutomaticSkillApplicable({ skill: slurmSkill, server: { name: "scnet-gpu", host: "qdeshell.hpccube.com" }, scheduler: "slurm" }), false);
  assert.equal(isAutomaticSkillApplicable({ skill: slurmSkill, serverName: "107.ustc.edu.cn", scheduler: "slurm" }), true);
  assert.equal(isAutomaticSkillApplicable({ skill: slurmSkill, serverName: "ordinary-server", scheduler: "unknown" }), false);
  assert.equal(isAutomaticSkillApplicable({
    skill: { name: "通用 Slurm 基线", description: "为 Slurm CPU 作业生成 README、JSON 结果并检查 UTC 时间。" },
    server: { name: "scnet-gpu", host: "qdeshell.hpccube.com" },
    scheduler: "slurm",
  }), true);
  assert.equal(isAutomaticSkillApplicable({
    skill: { name: "服务器健康检查", description: "检查磁盘、内存和系统负载。" },
    serverName: "reta服务器",
    scheduler: "none",
  }), true);
});

function skillInput(overrides = {}) {
  return {
    skillId: "shell-helper",
    manifest: {
      name: "Shell Helper",
      description: "读取远程环境",
      entrypoint: "scripts/main.mjs",
      permissions: ["remote.read"],
    },
    files: [
      { path: "scripts/main.mjs", content: "export default async () => 'ok';\n" },
      { path: "README.md", content: "# Shell Helper\n" },
    ],
    expectedRevision: 0,
    ...overrides,
  };
}

async function fixture(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-skills-"));
  try {
    return await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("上传 Skill 在 Actor 目录保存唯一安装内容", async () => {
  await fixture(async (dataRoot) => {
    for (const currentActor of [actor("user", "same_skill"), actor("guest", "same_skill")]) {
      const service = new SkillService(serviceOptions(dataRoot, currentActor));
      const uploaded = await service.uploadPackage(skillInput());
      assert.equal(uploaded.duplicate, false);
      assert.equal(Object.hasOwn(uploaded.skill, "version"), false);
      assert.equal(uploaded.skill.manifest.entrypoint, "scripts/main.mjs");
      const root = actorDataRoot(dataRoot, currentActor);
      const packageRoot = path.join(root, "skills", "packages", "shell-helper", ".installed");
      assert.equal(await readFile(path.join(packageRoot, "files", "README.md"), "utf8"), "# Shell Helper\n");
      const descriptor = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      assert.equal(descriptor.sha256, uploaded.skill.sha256);
      assert.deepEqual(descriptor.files.map((file) => file.path), ["README.md", "scripts/main.mjs"]);
      assert.match(packageRoot, currentActor.actorType === "user" ? /[\\/]users[\\/]same_skill[\\/]/ : /[\\/]guests[\\/]same_skill[\\/]/);
      const catalog = await service.listInstalledKnowledge();
      assert.deepEqual(catalog.items[0].applicability, { mode: "all", serverKind: "all", allowServers: [], denyServers: [], forceEnabled: false });
      assert.deepEqual(catalog.items.map((entry) => ({ skillId: entry.skillId, knowledge: entry.knowledge })), [{
        skillId: "shell-helper",
        knowledge: { key: "skill:shell-helper", version: uploaded.skill.sha256 },
      }]);
    }
  });
});

test("内部 Skill 目录始终携带当前 applicability，个人配置覆盖默认范围", async () => {
  await fixture(async (dataRoot) => {
    const service = new SkillService(serviceOptions(dataRoot, actor()));
    await service.uploadPackage(skillInput());
    await service.updateApplicability("shell-helper", { serverKind: "standard", allowServers: [], denyServers: [] });
    const catalog = await service.listInstalledKnowledge();
    assert.deepEqual(catalog.items[0].applicability, { mode: "all", serverKind: "standard", allowServers: [], denyServers: [], forceEnabled: false });
    for (const mode of ["work", "all"]) {
      await service.updateApplicability("shell-helper", { mode, serverKind: "compute", forceEnabled: true });
      const reloaded = new SkillService(serviceOptions(dataRoot, actor()));
      assert.deepEqual((await reloaded.listInstalledKnowledge()).items[0].applicability, {
        mode, serverKind: "compute", allowServers: [], denyServers: [], forceEnabled: true,
      });
    }
  });
});

test("同时安装多个 Skill 时，初始范围与安装在同一写队列内且后续安装不覆盖个人配置", async () => {
  await fixture(async (dataRoot) => {
    const service = new SkillService(serviceOptions(dataRoot, actor()));
    const [first, second] = await Promise.all([
      service.installPackage({ ...skillInput({ skillId: "scope-a" }), applicability: { mode: "work", allowServers: ["server-a"] } }),
      service.installPackage({ ...skillInput({ skillId: "scope-b" }), applicability: { mode: "all", denyServers: ["server-b"], forceEnabled: true } }),
    ]);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, false);
    await service.updateApplicability("scope-a", { mode: "chat" });
    await service.installPackage({ ...skillInput({ skillId: "scope-a", version: "2.0.0" }), applicability: { mode: "work", forceEnabled: true } });
    const items = (await service.listInstalled()).items;
    assert.equal(items.find((item) => item.skillId === "scope-a").applicability.mode, "chat");
    assert.deepEqual(items.find((item) => item.skillId === "scope-b").applicability.denyServers, ["server-b"]);
    await assert.rejects(() => service.installPackage({ ...skillInput({ skillId: "invalid-scope" }), applicability: { mode: "chat", forceEnabled: true } }));
    assert.equal((await service.listInstalled()).items.some((item) => item.skillId === "invalid-scope"), false);
  });
});

test("Windows 最终 rename EPERM 时以 package.json 最后提交，Registry 在包提交后才可见", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const actorRoot = actorDataRoot(dataRoot, currentActor);
    const indexPath = path.join(actorRoot, "skills", "index.json");
    const operations = [];
    let renameCalls = 0;
    const packageFileSystem = {
      ...fsPromises,
      async rename() {
        renameCalls += 1;
        const error = new Error("simulated Windows directory lock");
        error.code = "EPERM";
        throw error;
      },
      async cp(source, destination, options) {
        operations.push("files");
        return fsPromises.cp(source, destination, options);
      },
      async copyFile(source, destination, flags) {
        operations.push("package.json");
        await assert.rejects(() => readFile(indexPath, "utf8"), (error) => error?.code === "ENOENT");
        return fsPromises.copyFile(source, destination, flags);
      },
    };
    const service = new SkillService(serviceOptions(dataRoot, currentActor, {
      packageFileSystem,
      packageCommitSleep: async () => undefined,
    }));

    const uploaded = await service.uploadPackage(skillInput());
    assert.equal(renameCalls, 8);
    assert.deepEqual(operations, ["files", "package.json"]);
    const packageRoot = path.join(actorRoot, "skills", "packages", "shell-helper", ".installed");
    const descriptor = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    assert.equal(descriptor.sha256, uploaded.skill.sha256);
    assert.equal(index.data.skills.length, 1);
    assert.equal(index.data.skills[0].sha256, descriptor.sha256);
  });
});

test("磁盘上已有已提交包时绝不覆盖或清理其内容", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const packageRoot = path.join(actorDataRoot(dataRoot, currentActor), "skills", "packages", "shell-helper", ".installed");
    await fsPromises.mkdir(path.join(packageRoot, "files"), { recursive: true });
    await writeFile(path.join(packageRoot, "files", "sentinel.txt"), "keep\n", "utf8");
    await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
      schemaVersion: 1,
      skillId: "shell-helper",
      version: "1.0.0",
      sha256: "different-committed-package",
    })}\n`, "utf8");

    const service = new SkillService(serviceOptions(dataRoot, currentActor));
    await assert.rejects(() => service.uploadPackage(skillInput()), (error) => error?.code === "SKILL_PACKAGE_PATH_CONFLICT");
    assert.equal(await readFile(path.join(packageRoot, "files", "sentinel.txt"), "utf8"), "keep\n");
    const descriptor = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(descriptor.sha256, "different-committed-package");
  });
});

test("manifest 与文件 path 使用严格 schema，危险包不会在 Actor 目录留下文件", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const service = new SkillService(serviceOptions(dataRoot, currentActor));
    await assert.rejects(() => service.uploadPackage(skillInput({
      manifest: { ...skillInput().manifest, extra: "legacy" },
    })), (error) => error?.code === "SKILL_MANIFEST_SCHEMA_INVALID");
    await assert.rejects(() => service.uploadPackage(skillInput({
      files: [{ path: "../escape.mjs", content: "bad" }],
      manifest: { ...skillInput().manifest, entrypoint: "../escape.mjs" },
    })), (error) => error?.code === "SKILL_FILE_PATH_INVALID");
    await assert.rejects(() => service.uploadPackage(skillInput({
      manifest: { ...skillInput().manifest, entrypoint: "scripts/missing.mjs" },
    })), (error) => error?.code === "SKILL_ENTRYPOINT_MISSING");
    await assert.rejects(() => access(path.join(actorDataRoot(dataRoot, currentActor), "skills", "packages")));
  });
});

test("同一技能只保留当前安装内容，相同上传幂等，内容更新原位替换", async () => {
  await fixture(async (dataRoot) => {
    const service = new SkillService(serviceOptions(dataRoot, actor()));
    const first = await service.uploadPackage(skillInput());
    const duplicate = await service.uploadPackage(skillInput({ expectedRevision: first.revision }));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, first.revision);
    const changed = await service.uploadPackage(skillInput({ expectedRevision: first.revision, files: [{ path: "scripts/main.mjs", content: "changed" }] }));
    assert.equal(changed.skill.id, first.skill.id);
    assert.equal(changed.skill.packagePath, first.skill.packagePath);
    assert.notEqual(changed.skill.sha256, first.skill.sha256);
    assert.deepEqual((await service.inspect()).data.skills, [changed.skill]);
    assert.equal(service.activateVersion, undefined);
    assert.equal(service.deleteVersion, undefined);
  });
});
test("部署按任务授权读取当前技能，卸载不再受到历史选择的锁定", async () => {
  await fixture(async (dataRoot) => {
    const service = new SkillService(serviceOptions(dataRoot, actor()));
    const installed = await service.uploadPackage(skillInput());
    await service.createDeploymentPlan({ taskId: "task_a", skills: [{ skillId: "shell-helper" }] });
    await assert.rejects(() => service.createDeploymentPlan({ taskId: "task_forbidden", skills: [{ skillId: "shell-helper" }] }), { code: "SKILL_TASK_FORBIDDEN" });
    await service.uninstall({ skillId: "shell-helper", expectedRevision: installed.revision });
    assert.deepEqual((await service.inspect()).data, { skills: [] });
    await assert.rejects(() => service.resolveSkills([{ knowledge: { key: "skill:shell-helper" } }]), { code: "SKILL_NOT_INSTALLED" });
  });
});
test("卸载技能会移除当前包、索引和范围配置", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const service = new SkillService(serviceOptions(dataRoot, currentActor));
    const installed = await service.installPackage(skillInput({ applicability: { mode: "work", forceEnabled: true } }));
    await service.uninstall({ skillId: "shell-helper", expectedRevision: installed.revision });
    assert.deepEqual((await service.inspect()).data, { skills: [] });
    assert.deepEqual((await service.listInstalled()).items, []);
    await assert.rejects(() => access(path.join(actorDataRoot(dataRoot, currentActor), "skills/packages/shell-helper")));
  });
});
test("部署计划只指向 ~/.easywork/skills，按远端 hash 幂等，并向 Agent 暴露固定 entrypoint", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const service = new SkillService(serviceOptions(dataRoot, currentActor));
    const uploaded = await service.uploadPackage(skillInput());
    const pinned = { taskSkillPins: [{ skillId: "shell-helper" }] };
    const plan = await service.createDeploymentPlan({ taskId: "task_a", pins: pinned.taskSkillPins });
    assert.equal(plan.remoteBase, "~/.easywork/skills");
    assert.equal(plan.skills.length, 1);
    assert.equal(plan.skills[0].operations.length, 2);
    assert.equal(plan.agentSkillRefs[0].entrypoint, "~/.easywork/skills/shell-helper/scripts/main.mjs");
    assert.ok(plan.skills[0].files.every((file) => file.target.path.startsWith("~/.easywork/skills/shell-helper/")));
    assert.ok(plan.skills[0].files.every((file) => file.source.actorRelativePath.startsWith("skills/packages/")));
    assert.equal(JSON.stringify(plan).includes(".claude"), false);
    assert.equal(JSON.stringify(plan).includes(".codex"), false);
    assert.equal(JSON.stringify(plan).includes(".config/opencode"), false);

    const remoteHashes = Object.fromEntries(plan.skills[0].files.map((file) => [file.target.path, file.source.sha256]));
    const idempotent = await service.createDeploymentPlan({ taskId: "task_a", pins: pinned.taskSkillPins, remoteHashes });
    assert.equal(idempotent.skills[0].operations.length, 0);
    assert.ok(idempotent.skills[0].files.every((file) => file.status === "up-to-date"));
    const prepared = await service.prepare({
      task: { id: "task_a", actorId: currentActor.actorId },
      pins: pinned.taskSkillPins,
      workspace: { path: "/ignored" },
      remoteHashes,
    });
    assert.deepEqual(prepared.agentSkillRefs, idempotent.agentSkillRefs);
  });
});

test("Skill 检索读取当前安装内容并保持 Actor 隔离", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const service = new SkillService(serviceOptions(dataRoot, currentActor));
    const uploaded = await service.uploadPackage(skillInput({
      files: [
        { path: "scripts/main.mjs", content: "export default async () => 'EW-SKILL-PROOF-C7';\n" },
        { path: "SKILL.md", content: "创建 skill-proof.txt，内容必须是 EW-SKILL-PROOF-C7。\n" },
        { path: "assets/binary.bin", content: Buffer.from([0, 1, 2, 3]) },
      ],
    }));
    const results = await service.searchContext({
      query: "验收 Skill 创建文件",
      selectedSkillIds: ["shell-helper"],
      limit: 4,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].skillId, "shell-helper");
    assert.equal(Object.hasOwn(results[0], "version"), false);
    assert.equal(results[0].sha256, uploaded.skill.sha256);
    assert.match(results[0].files.find((entry) => entry.path === "SKILL.md").content, /skill-proof\.txt/);
    assert.match(results[0].files.find((entry) => entry.path === "scripts\/main\.mjs").content, /EW-SKILL-PROOF-C7/);
    assert.equal(results[0].files.some((entry) => entry.path === "assets/binary.bin"), false);

    const otherActor = new SkillService(serviceOptions(dataRoot, actor("user", "other_skill_owner")));
    assert.deepEqual(await otherActor.searchContext({ query: "EW-SKILL-PROOF-C7" }), []);
  });
});

test("生成部署描述符前会重新验证本地文件完整性", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const service = new SkillService(serviceOptions(dataRoot, currentActor));
    const uploaded = await service.uploadPackage(skillInput());
    const pinned = { taskSkillPins: [{ skillId: "shell-helper" }] };
    const entrypoint = path.join(actorDataRoot(dataRoot, currentActor), "skills", "packages", "shell-helper", ".installed", "files", "scripts", "main.mjs");
    await writeFile(entrypoint, "tampered\n", "utf8");
    await assert.rejects(() => service.createDeploymentPlan({
      taskId: "task_a",
      pins: pinned.taskSkillPins,
    }), (error) => error?.code === "SKILL_PACKAGE_FILE_CORRUPT");
  });
});

test("并发上传使用 Actor 级串行队列，旧 expectedRevision 不会覆盖新 Registry", async () => {
  await fixture(async (dataRoot) => {
    const service = new SkillService(serviceOptions(dataRoot, actor()));
    const first = service.uploadPackage(skillInput());
    const stale = service.uploadPackage(skillInput({
      skillId: "second-skill",
      manifest: { ...skillInput().manifest, name: "Second" },
      expectedRevision: 0,
    }));
    const [firstResult, staleResult] = await Promise.allSettled([first, stale]);
    assert.equal(firstResult.status, "fulfilled");
    assert.equal(staleResult.status, "rejected");
    assert.equal(staleResult.reason.code, "REVISION_CONFLICT");
    const state = await service.inspect();
    assert.equal(state.data.skills.length, 1);
    assert.equal(state.data.skills[0].skillId, "shell-helper");
    await assert.rejects(() => access(path.join(actorDataRoot(dataRoot, actor()), "skills", "packages", "second-skill")));
  });
});
