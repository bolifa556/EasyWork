const ABSOLUTE_PATH = /(?:^|[\s`'"（(])(?:\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@+~-]+){1,}|[A-Za-z]:\\[^\s`'"，。；：]+)/m;
const LIVE_MEASUREMENT = /(?:\b(?:load(?:avg)?|nvidia-smi|free\s+-|df\s+-|uptime|jobs?)\b|\d+(?:\.\d+)?\s*(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b|\b(?:HTTP|API)\s*(?:状态|返回|响应)?\s*[245]\d\d\b|当前(?:占用|剩余|空闲|负载|作业|任务|节点)|实时(?:状态|资源|负载|用量))/iu;
const TRANSIENT_RESULT = /(?:已开始(?:检查|查询|执行|下载)|正在(?:检查|查询|执行|下载|运行|等待)|具体结果(?:未见|未知|尚无)|未见(?:进一步|后续|结果)|本次(?:检查|查询|测试)|暂未|刚刚|目前没有|当前没有)/u;
const TRANSIENT_SUBJECT = /(?:工作区文件检查请求|环境所在节点|模型连通性|服务器集群架构与资源|账号关联的分区与\s*qos|存储容量|当前状态|实时资源)/iu;
const NON_DURABLE_SUBJECT = /^(?:测试|test|工具调用(?:记忆)?|编辑授权确认|权限确认|计划工具调用)$/iu;
const NON_DURABLE_CONTENT = /(?:不实际存在可供未来复用|仅是关于.{0,40}(?:工具|tool).{0,40}一次性指令|只回复\s*[A-Z][A-Z0-9_]*_OK|作为.{0,24}测试|确认了编辑授权)/iu;
const FILE_STATE_SUBJECT = /(?:^|[\\/])[^\s\\/]+\.[A-Za-z0-9]{1,12}(?:\s+(?:content|内容|状态|创建|修改|删除|失败))?$/iu;
const TRANSIENT_FAILURE = /(?:文件未能(?:创建|修改|删除)|未能(?:创建|修改|删除|完成|执行)|(?:执行|连接|调用|读取|写入|创建|修改|删除).{0,24}失败|沙箱.{0,48}(?:崩溃|缺少|不可用)|结果未知|是否.{0,32}未知)/iu;
const SOURCE_HANDLING_POLICY = /(?:文件|资料|文档|Skill|记忆).{0,48}(?:指令性文字|指令|提示).{0,64}(?:只作为(?:资料|文本|事实)|不(?:会)?执行|不(?:会)?采纳|不改变回答方式)/iu;
const WORK_PRODUCT_INVENTORY_SUBJECT = /(?:项目|工作区|代码|文件|目录).{0,16}(?:结构|清单|现状|当前实现|实现状态|库\s*\/\s*cli\s*行为)/iu;
const RELATIVE_FILE_REFERENCE = /(?:^|[\s`'"（(])(?:[A-Za-z0-9_.@+-]+\/)+(?:[A-Za-z0-9_.@+-]+)(?=$|[\s`'"，。；：)、])/gmu;
const BARE_FILE_REFERENCE = /\b[A-Za-z0-9_.@+-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|md|sh|bash|zsh|ps1|bat|cmd|java|go|rs|c|cc|cpp|h|hpp|sql|html|css)\b/giu;
const DURABLE_INTENT = /(?:请记住|以后|今后|后续|默认|始终|长期|统一|一律|固定|项目约定|作为约定|整个项目)/u;
const STABLE_FACT_ANCHOR = /[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)+|\b\d{2,}(?:\.\d+)?\b/gu;
const LATIN_WORD = /[\p{L}\p{N}_-]{3,}/gu;

function normalizedEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function stableFactAnchors(value) {
  const matches = String(value || "").normalize("NFKC").match(STABLE_FACT_ANCHOR) || [];
  return new Set(matches.map((entry) => entry.toLocaleLowerCase("en-US")));
}

function characterBigrams(value) {
  const normalized = normalizedEvidenceText(value);
  const result = new Set();
  for (let index = 0; index + 1 < normalized.length; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

function latinWords(value) {
  const matches = String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").match(LATIN_WORD) || [];
  return new Set(matches.filter((entry) => /[a-z]/iu.test(entry)));
}

function evidenceContent(value) {
  return String(value?.knowledge?.content ?? value?.content ?? "").trim();
}

function evidenceProfiles(values) {
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const content = evidenceContent(value);
    if (!content) return [];
    return [{
      normalized: normalizedEvidenceText(content),
      bigrams: characterBigrams(content),
      anchors: stableFactAnchors(content),
      words: latinWords(content),
    }];
  });
}

function overlapCount(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function subsetOf(left, right) {
  return [...left].every((value) => right.has(value));
}

function containsSharedPhrase(candidate, profiles, width = 9) {
  if (candidate.length < width) return false;
  for (let index = 0; index + width <= candidate.length; index += 1) {
    const phrase = candidate.slice(index, index + width);
    if (profiles.some((profile) => profile.normalized.includes(phrase))) return true;
  }
  return false;
}

/**
 * A retrieved memory, file excerpt, or Skill is evidence for the current
 * answer, not a new durable fact discovered by that answer.  Detect direct
 * copies and conservative paraphrases in code so the same knowledge cannot
 * become a second memory source on the next conversation.
 */
export function derivedFromObservedKnowledge(candidate, observedKnowledge = []) {
  const content = String(candidate?.content || "").trim();
  const normalized = normalizedEvidenceText(content);
  if (normalized.length < 4) return false;
  const profiles = evidenceProfiles(observedKnowledge);
  if (!profiles.length) return false;
  if (profiles.some((profile) => normalized.length >= 8 && profile.normalized.includes(normalized))) return true;
  if (containsSharedPhrase(normalized, profiles)) return true;

  const candidateBigrams = characterBigrams(content);
  const candidateAnchors = stableFactAnchors(content);
  const candidateWords = latinWords(content);
  // A candidate can paraphrase a small combination of sources (for example a
  // project preference plus a file fact).  Limit the union to the three most
  // overlapping sources so a large knowledge library does not become a broad
  // false-positive dictionary.
  const closest = profiles
    .map((profile) => ({ profile, overlap: overlapCount(candidateBigrams, profile.bigrams) }))
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, 3)
    .map((entry) => entry.profile);
  const observedBigrams = new Set(closest.flatMap((profile) => [...profile.bigrams]));
  const observedAnchors = new Set(closest.flatMap((profile) => [...profile.anchors]));
  const observedWords = new Set(closest.flatMap((profile) => [...profile.words]));
  const bigramHits = overlapCount(candidateBigrams, observedBigrams);
  const bigramCoverage = candidateBigrams.size ? bigramHits / candidateBigrams.size : 0;
  const wordHits = overlapCount(candidateWords, observedWords);
  const wordCoverage = candidateWords.size ? wordHits / candidateWords.size : 0;

  if (candidateAnchors.size >= 2 && subsetOf(candidateAnchors, observedAnchors)) return true;
  if (candidateAnchors.size === 1 && subsetOf(candidateAnchors, observedAnchors) && bigramHits >= 8 && bigramCoverage >= 0.3) return true;
  if (bigramHits >= 12 && bigramCoverage >= 0.4) return true;
  return candidateWords.size >= 3 && wordHits >= 3 && wordCoverage >= 0.6;
}

function fileReferenceCount(value) {
  const text = String(value || "");
  return new Set([
    ...(text.match(RELATIVE_FILE_REFERENCE) || []).map((entry) => entry.trim()),
    ...(text.match(BARE_FILE_REFERENCE) || []),
  ]).size;
}

function describesWorkProductInventory(candidate) {
  const semanticKey = String(candidate?.semanticKey || "");
  const content = String(candidate?.content || "");
  return fileReferenceCount(content) >= 2
    && (WORK_PRODUCT_INVENTORY_SUBJECT.test(semanticKey)
      || /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*[^\n]*(?:\/[A-Za-z0-9_.@+-]+|\.[A-Za-z0-9]{1,12})/mu.test(content));
}

export function durableMemoryCandidate(candidate, { userMessage = "", observedKnowledge = [], mode = "chat" } = {}) {
  const semanticKey = String(candidate?.semanticKey || "").trim();
  const content = String(candidate?.content || "").trim();
  if (!semanticKey || !content || content.length > 2_000) return false;
  if (ABSOLUTE_PATH.test(content)
    || LIVE_MEASUREMENT.test(content)
    || TRANSIENT_RESULT.test(content)
    || TRANSIENT_SUBJECT.test(semanticKey)
    || NON_DURABLE_SUBJECT.test(semanticKey)
    || FILE_STATE_SUBJECT.test(semanticKey)
    || TRANSIENT_FAILURE.test(content)
    || SOURCE_HANDLING_POLICY.test(content)
    || NON_DURABLE_CONTENT.test(content)
    || describesWorkProductInventory(candidate)
    || derivedFromObservedKnowledge(candidate, observedKnowledge)) return false;

  // A Work result must contribute newly discovered, reusable knowledge.  A
  // paraphrase of its one-turn request is already preserved in conversation
  // history and must not be promoted into project memory merely because the
  // remote Agent restated it. Explicit future defaults remain eligible.
  if (mode === "work"
    && !DURABLE_INTENT.test(String(userMessage || ""))
    && derivedFromObservedKnowledge(candidate, [{ content: userMessage }])) return false;

  // User-wide defaults must be explicitly grounded in what the user said;
  // an Agent observation is not allowed to promote a server discovery into a
  // cross-project preference.
  if (candidate?.level === "user") {
    const source = String(userMessage || "").normalize("NFKC");
    if (!source) return false;
    const preferenceSignal = /(?:我希望|我需要|请始终|以后|默认|偏好|不要|必须|只要|仅限|允许|不允许)/u;
    if (!preferenceSignal.test(source)) return false;
  }
  return true;
}

export function durableStoredMemory(semanticKey, content) {
  return durableMemoryCandidate({ semanticKey, content, level: "project" });
}
