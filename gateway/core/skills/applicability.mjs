import { invariant } from "../errors.mjs";

const COMPUTE_PLATFORM_PATTERN = /(?:slurm|sbatch|srun|squeue|scontrol|pbs|qsub|qstat|gpu|qos|算力平台|计算节点|登录节点|调度器|队列|分区|作业|超算|集群)/iu;
const SLURM_PATTERN = /(?:slurm|sbatch|srun|squeue|scontrol)/iu;
const PBS_PATTERN = /(?:\bpbs\b|qsub|qstat)/iu;
const GENERIC_SERVER_TOKENS = new Set(["server", "servers", "host", "hosts", "localhost", "local", "remote", "easywork"]);
const GENERIC_COMPUTE_IDENTIFIERS = new Set([
  "api", "cli", "cpu", "cuda", "gpu", "hpc", "http", "https", "json", "mcp", "nvidia", "pbs", "posix", "qos", "ssh", "url", "yaml",
]);
const SERVER_KINDS = new Set(["all", "compute", "standard"]);
const SKILL_MODES = new Set(["all", "chat", "work"]);
const REMOTE_DOWNLOAD_SKILL_IDS = new Set(["skill_remote_download", "remote-download"]);
const REMOTE_DOWNLOAD_REQUEST_PATTERN = /(?:下载|导出|交付|传给我|发给我|给我(?:一个|一份|这些|该|这个)?(?:文件|压缩包)|提供.{0,12}(?:文件|压缩包|下载)|\bdownload\b|\bexport\b|\bdeliver\b|\battach(?:ment)?\b)/iu;
const CHAT_ONLY_SKILL_PATTERN = /(?:仅|只)?适用于\s*(?:chat|聊天)(?:\s*模式)?(?:\s*对话)?|(?:chat|聊天)[\s_-]*only/iu;
const WORK_ONLY_SKILL_PATTERN = /(?:仅|只)?适用于\s*(?:work|工作)(?:\s*模式)?(?:\s*对话)?|(?:work|工作)[\s_-]*only/iu;
const EXPLICIT_REQUEST_ONLY_PATTERN = /\b(?:use|apply)\s+only\s+when\b[\s\S]{0,80}\bexplicit(?:ly)?\b|\bonly\s+when\s+(?:the\s+)?user\s+explicit(?:ly)?\b|(?:仅当|只有|只在)用户明确(?:询问|要求|请求|提及)/iu;
export const DEFAULT_SKILL_APPLICABILITY = Object.freeze({ mode: "all", serverKind: "all", allowServers: Object.freeze([]), denyServers: Object.freeze([]), forceEnabled: false });

function explicitRequestPhrases(value) {
  const text = String(value || "").normalize("NFKC");
  const phrases = [];
  for (const match of text.matchAll(/["“”']([^"“”'\r\n]{2,96})["“”']/gu)) phrases.push(match[1]);
  for (const match of text.matchAll(/\brequests?\s+(?:the\s+)?([^.;\r\n]{3,96})/giu)) phrases.push(match[1]);
  return [...new Set(phrases.map((entry) => entry.trim()).filter(Boolean))];
}

function explicitRequestOnlySkillIsNamed(skillText, skillName, request) {
  if (!EXPLICIT_REQUEST_ONLY_PATTERN.test(skillText)) return true;
  const normalizedRequest = String(request || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
  const normalizedName = String(skillName || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  if (normalizedName && normalizedRequest.includes(normalizedName)) return true;
  return explicitRequestPhrases(skillText).some((phrase) => normalizedRequest.includes(phrase.toLocaleLowerCase("zh-CN")));
}

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
  if (skill?.applicability?.mode) return skill.applicability.mode === "all" || skill.applicability.mode === mode;
  const skillText = [skill?.name, skill?.description].filter(Boolean).join("\n").normalize("NFKC");
  const chatOnly = CHAT_ONLY_SKILL_PATTERN.test(skillText);
  const workOnly = WORK_ONLY_SKILL_PATTERN.test(skillText);
  return chatOnly === workOnly || (mode === "chat" ? !workOnly : !chatOnly);
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

function platformTokens(value) {
  return new Set(
    String(value || "")
      .toLocaleLowerCase("en-US")
      .match(/[a-z0-9]{3,}/gu)
      ?.filter((token) => !GENERIC_SERVER_TOKENS.has(token) && !/^\d+$/.test(token)) || [],
  );
}

function serverText(server = {}, serverName = "") {
  return [server.id, server.serverId, server.serverIdentity, server.name, server.host, serverName]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function explicitlyNamesServer(skillText, currentServerText) {
  const serverTokens = platformTokens(currentServerText);
  if (!serverTokens.size) return false;
  const skillTokens = platformTokens(skillText);
  return [...serverTokens].some((token) => skillTokens.has(token));
}

function explicitPlatformIdentifiers(skillText) {
  const text = String(skillText || "");
  const identifiers = [];
  const patterns = [
    /(?:适用于|面向|针对|部署到|运行于|运行在|在)\s*([A-Z][A-Z0-9]{2,})\b(?=[\s\S]{0,24}(?:算力平台|平台|登录节点|计算节点|集群|超算))/gu,
    /\b([A-Z][A-Z0-9]{2,})\b\s*(?:本科生)?(?:算力平台|平台|集群|超算)/gu,
    /(?:算力平台|平台|集群|超算)\s*(?:是|为|：|:)?\s*([A-Z][A-Z0-9]{2,})\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) identifiers.push(match[1]);
  }
  return new Set(identifiers
    .map((token) => token.toLocaleLowerCase("en-US"))
    .filter((token) => !GENERIC_COMPUTE_IDENTIFIERS.has(token)));
}

function matchesExplicitPlatformIdentity(skillText, currentServerText) {
  const identifiers = explicitPlatformIdentifiers(skillText);
  if (!identifiers.size) return true;
  const currentTokens = platformTokens(currentServerText);
  return [...identifiers].some((identifier) => currentTokens.has(identifier));
}

export function isAutomaticSkillApplicable({ skill, server = {}, serverName = "", scheduler = "unknown" } = {}) {
  const currentServerText = serverText(server, serverName);
  if (skill?.applicability) {
    const descriptor = { ...server };
    if (!descriptor.name && serverName) descriptor.name = serverName;
    return isSkillApplicableToServer({ skill, server: descriptor, scheduler });
  }
  const skillText = [skill?.name, skill?.description].filter(Boolean).join("\n");
  if (!COMPUTE_PLATFORM_PATTERN.test(skillText)) return true;
  if (!matchesExplicitPlatformIdentity(skillText, currentServerText)) return false;

  const normalizedScheduler = String(scheduler || "unknown").trim().toLocaleLowerCase("en-US");
  const requiresSlurm = SLURM_PATTERN.test(skillText);
  const requiresPbs = PBS_PATTERN.test(skillText);

  if (normalizedScheduler === "slurm") return !requiresPbs || requiresSlurm;
  if (normalizedScheduler === "pbs") return !requiresSlurm || requiresPbs;
  if (normalizedScheduler === "generic") return !requiresSlurm && !requiresPbs;
  if (normalizedScheduler === "none") return false;
  return explicitlyNamesServer(skillText, currentServerText);
}

export function isAutomaticSkillRelevantToRequest({ skill, request = "", mode = "work" } = {}) {
  const normalizedMode = String(mode || "work").trim().toLocaleLowerCase("en-US");
  if (!isSkillApplicableToMode({ skill, mode: normalizedMode })) return false;
  const skillText = [skill?.name, skill?.description].filter(Boolean).join("\n").normalize("NFKC");
  const skillId = String(skill?.skillId || skill?.id || "").trim().toLocaleLowerCase("en-US");
  const skillName = String(skill?.name || "").normalize("NFKC").trim();
  if (!explicitRequestOnlySkillIsNamed(skillText, skillName, request)) return false;
  const isRemoteDownload = REMOTE_DOWNLOAD_SKILL_IDS.has(skillId) || skillName === "远程文件下载";
  if (!isRemoteDownload) return true;
  return REMOTE_DOWNLOAD_REQUEST_PATTERN.test(String(request || "").normalize("NFKC"));
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
