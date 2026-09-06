import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SKILL_APPLICABILITY,
  filterEligibleSkillObservations,
  isAutomaticSkillRelevantToRequest,
  isForcedWorkSkill,
  isSkillApplicableToMode,
  isSkillApplicableToServer,
  normalizeSkillApplicability,
} from "../gateway/core/skills/applicability.mjs";

const SERVER = {
  id: "server_a",
  serverIdentity: "ssh_identity_a",
  name: "USTC 算力节点",
  host: "107.ustc.edu.cn",
};

test("显式模式先于简介约定，全部模式和工作模式均允许强制启用", () => {
  const skill = { name: "平台说明", description: "适用于 chat 模式", applicability: { mode: "work", forceEnabled: true } };
  assert.equal(isSkillApplicableToMode({ skill, mode: "chat" }), false);
  assert.equal(isSkillApplicableToMode({ skill, mode: "work" }), true);
  assert.equal(isForcedWorkSkill(skill), true);
  assert.equal(isForcedWorkSkill({ applicability: { mode: "all", forceEnabled: true } }), true);
  assert.equal(isForcedWorkSkill({ applicability: { mode: "all", forceEnabled: false } }), false);
  assert.equal(isForcedWorkSkill({ applicability: { mode: "chat", forceEnabled: true } }), false);
  assert.equal(normalizeSkillApplicability({ mode: "all", forceEnabled: true }).forceEnabled, true);
  assert.equal(isSkillApplicableToMode({ skill: { ...skill, applicability: { mode: "all" } }, mode: "work" }), true);
  assert.equal(isSkillApplicableToMode({ skill: { ...skill, applicability: { mode: "all" } }, mode: "chat" }), true);
  for (const value of [{ mode: "chat", forceEnabled: true }, { mode: "invalid" }, { mode: "work", forceEnabled: "true" }]) {
    assert.throws(() => normalizeSkillApplicability(value), (error) => error.code === "SKILL_APPLICABILITY_INVALID");
  }
});

test("skill applicability separates compute and standard servers before Agent search", () => {
  assert.deepEqual(normalizeSkillApplicability(), DEFAULT_SKILL_APPLICABILITY);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { serverKind: "compute" } }, server: SERVER, scheduler: "slurm" }), true);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { serverKind: "compute" } }, server: SERVER, scheduler: "none" }), false);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { serverKind: "standard" } }, server: SERVER, scheduler: "none" }), true);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { serverKind: "standard" } }, server: SERVER, scheduler: "slurm" }), false);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { serverKind: "compute" } }, server: SERVER, scheduler: "unknown" }), false);
});

test("skill applicability matches server identifiers case-insensitively and deny wins", () => {
  const allowed = { applicability: { serverKind: "all", allowServers: ["107.USTC.EDU.CN"], denyServers: [] } };
  assert.equal(isSkillApplicableToServer({ skill: allowed, server: SERVER, scheduler: "slurm" }), true);
  assert.equal(isSkillApplicableToServer({ skill: allowed, server: { id: "server_b", host: "elsewhere.example" }, scheduler: "none" }), false);
  const denied = { applicability: { serverKind: "all", allowServers: ["server_a"], denyServers: ["ssh_identity_a"] } };
  assert.equal(isSkillApplicableToServer({ skill: denied, server: SERVER, scheduler: "slurm" }), false);
  assert.throws(
    () => normalizeSkillApplicability({ allowServers: ["SERVER_A"], denyServers: ["server_a"] }),
    (error) => error?.code === "SKILL_APPLICABILITY_CONFLICT",
  );
});

test("authorized Skill catalog stays visible for semantic selection across short follow-ups", () => {
  const skill = { skillId: "skill_remote_download", name: "远程文件下载" };
  assert.equal(isAutomaticSkillRelevantToRequest({ skill, request: "创建 README，然后读取验证安装章节" }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill, request: "帮我下载" }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill, request: "把生成的报告下载给我" }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill, request: "导出这些结果文件" }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill: { skillId: "other", name: "代码审查" }, request: "创建文件" }), true);
});

test("仅允许和禁止按服务器 ID、名称或主机名精确匹配，禁止和服务器类型约束优先", () => {
  for (const marker of [SERVER.id, SERVER.serverIdentity, SERVER.name, SERVER.host]) {
    assert.equal(isSkillApplicableToServer({ skill: { applicability: { allowServers: [marker] } }, server: SERVER }), true);
    assert.equal(isSkillApplicableToServer({ skill: { applicability: { denyServers: [marker] } }, server: SERVER }), false);
  }
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { allowServers: ["107.ustc.edu.cn.attacker.example", "USTC"] } }, server: SERVER }), false);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { allowServers: [SERVER.id], denyServers: [SERVER.host] } }, server: SERVER }), false);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { allowServers: [SERVER.host], serverKind: "standard" } }, server: SERVER, scheduler: "slurm" }), false);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { allowServers: [SERVER.host], forceEnabled: true } }, server: { id: "other-server", host: "other.example" }, scheduler: "slurm" }), false);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { denyServers: ["other.example"] } }, server: SERVER }), true);
  assert.equal(isSkillApplicableToServer({ skill: { applicability: { allowServers: ["  107.USTC.EDU.CN  "] } }, server: SERVER }), true);
});

test("description constraints are presented to the model without brittle text pre-filtering", () => {
  const skill = {
    skillId: "easywork-browser-e2e-marker",
    name: "easywork-browser-e2e-marker",
    description: 'Use only when the user explicitly asks for the "浏览器验收暗号" or requests the EasyWork Skill retrieval acceptance check.',
  };
  assert.equal(isAutomaticSkillRelevantToRequest({
    skill,
    request: "把 S08 的十对 fixture 口径压缩成一句可验收陈述。",
    mode: "work",
  }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({
    skill,
    request: "浏览器验收暗号是什么？",
    mode: "work",
  }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({
    skill,
    request: "Run the EasyWork Skill retrieval acceptance check.",
    mode: "work",
  }), true);
});

test("explicit chat-only and work-only Skill metadata is filtered before Web Agent discovery", () => {
  const chatOnly = {
    skillId: "chat-platform-guide",
    name: "本科生算力平台介绍",
    description: "面向本科生问答，适用于chat模式对话。",
  };
  const workOnly = {
    skillId: "work-platform-guide",
    name: "本科生算力平台使用规范",
    description: "规范远端执行，适用于 work 模式对话。",
  };
  const unscoped = { skillId: "general", name: "通用代码审查", description: "检查代码质量。" };

  assert.equal(isAutomaticSkillRelevantToRequest({ skill: chatOnly, request: "审计 Slurm 记录", mode: "work" }), false);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill: chatOnly, request: "如何提交作业", mode: "chat" }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill: workOnly, request: "如何提交作业", mode: "chat" }), false);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill: workOnly, request: "审计 Slurm 记录", mode: "work" }), true);
  assert.equal(isAutomaticSkillRelevantToRequest({ skill: unscoped, request: "只读审计", mode: "work" }), true);
});

test("historical Skill observations are hidden when the current request no longer considers them eligible", () => {
  const memory = { knowledge: { key: "memory:one", version: "v1" } };
  const remoteDownload = { knowledge: { key: "skill:skill_remote_download", version: "v1" } };
  const codeReview = { knowledge: { key: "skill:skill_code_review", version: "v1" } };

  assert.deepEqual(
    filterEligibleSkillObservations([memory, remoteDownload, codeReview], new Set(["skill_code_review"])),
    [memory, codeReview],
  );
});
