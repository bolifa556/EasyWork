import { invariant } from "../errors.mjs";

const SERVER_KINDS = new Set(["all", "compute", "standard"]);
const SKILL_MODES = new Set(["all", "chat", "work"]);
export const DEFAULT_SKILL_APPLICABILITY = Object.freeze({ mode: "all", serverKind: "all", allowServers: Object.freeze([]), denyServers: Object.freeze([]), forceEnabled: false });

function serverRules(value, field) {
  invariant(Array.isArray(value) && value.length <= 128, "SKILL_APPLICABILITY_INVALID", `${field} 无效`, { status: 400 });
  const normalized = value.map((entry) => String(entry || "").trim()).filter(Boolean);
  invariant(normalized.every((entry) => entry.length <= 256 && !entry.includes("\0")), "SKILL_APPLICABILITY_INVALID", `${field} 无效`, { status: 400 });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

export function normalizeSkillApplicability(value = {}) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "SKILL_APPLICABILITY_INVALID", "技能适用范围无效", { status: 400 });
  invariant(Object.keys(value).every((key) => ["mode", "serverKind", "allowServers", "denyServers", "forceEnabled"].includes(key)), "SKILL_APPLICABILITY_INVALID", "技能适用范围包含未知字段", { status: 400 });
  const mode = String(value.mode || "all");
  invariant(SKILL_MODES.has(mode), "SKILL_APPLICABILITY_INVALID", "技能适用模式无效", { status: 400 });
  const forceEnabled = value.forceEnabled ?? false;
  invariant(typeof forceEnabled === "boolean" && (!forceEnabled || mode !== "chat"), "SKILL_APPLICABILITY_INVALID", "仅全部模式或工作模式技能可以强制启用", { status: 400 });
  const serverKind = String(value.serverKind || "all");
  invariant(SERVER_KINDS.has(serverKind), "SKILL_APPLICABILITY_INVALID", "技能服务器类型无效", { status: 400 });
  const allowServers = serverRules(value.allowServers || [], "allowServers");
  const denyServers = serverRules(value.denyServers || [], "denyServers");
  const denied = new Set(denyServers.map((entry) => entry.toLocaleLowerCase("en-US")));
  invariant(!allowServers.some((entry) => denied.has(entry.toLocaleLowerCase("en-US"))), "SKILL_APPLICABILITY_CONFLICT", "同一服务器不能同时允许和禁止", { status: 400 });
  return { mode, serverKind, allowServers, denyServers, forceEnabled };
}

export function isSkillApplicableToMode({ skill, mode = "work" } = {}) {
  invariant(["chat", "work"].includes(mode), "SKILL_CONVERSATION_MODE_INVALID", "技能对话模式无效", { status: 400 });
  const applicability = normalizeSkillApplicability(skill?.applicability || DEFAULT_SKILL_APPLICABILITY);
  return applicability.mode === "all" || applicability.mode === mode;
}

export function isForcedWorkSkill(skill) {
  return ["all", "work"].includes(skill?.applicability?.mode) && skill.applicability.forceEnabled === true;
}

function normalizedServerMarkers(server = {}) {
  return new Set([server.id, server.serverId, server.serverIdentity, server.name, server.host]
    .map((value) => String(value || "").trim().toLocaleLowerCase("en-US"))
    .filter(Boolean));
}

export function isSkillApplicableToServer({ skill, server = {}, scheduler = "unknown" } = {}) {
  const applicability = normalizeSkillApplicability(skill?.applicability || DEFAULT_SKILL_APPLICABILITY);
  const markers = normalizedServerMarkers(server);
  const matches = (rule) => markers.has(String(rule).trim().toLocaleLowerCase("en-US"));
  if (applicability.denyServers.some(matches)) return false;
  if (applicability.allowServers.length && !applicability.allowServers.some(matches)) return false;
  const normalizedScheduler = String(scheduler || "unknown").trim().toLocaleLowerCase("en-US");
  const compute = ["slurm", "pbs", "generic"].includes(normalizedScheduler);
  const standard = normalizedScheduler === "none";
  if (applicability.serverKind === "compute" && !compute) return false;
  if (applicability.serverKind === "standard" && !standard) return false;
  return true;
}

export function isAutomaticSkillApplicable({ skill, server = {}, serverName = "", scheduler = "unknown" } = {}) {
  const descriptor = { ...server };
  if (!descriptor.name && serverName) descriptor.name = serverName;
  return isSkillApplicableToServer({ skill, server: descriptor, scheduler });
}

export function filterEligibleSkillObservations(fragments, eligibleSkillIds = []) {
  const eligible = eligibleSkillIds instanceof Set
    ? eligibleSkillIds
    : new Set((Array.isArray(eligibleSkillIds) ? eligibleSkillIds : []).map((entry) => String(entry)));
  return (Array.isArray(fragments) ? fragments : []).filter((fragment) => {
    const match = /^skill:(.+)$/.exec(String(fragment?.knowledge?.key || ""));
    return !match || eligible.has(match[1]);
  });
}
