function sourceText(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

export function workSourceIntent(value) {
  const text = sourceText(value);
  const mentionsMemory = /(?:长期|项目|用户|对话间|工作区)?记忆|\bmemory\b/u.test(text);
  const mentionsSkill = /\bskill\b|技能/u.test(text);
  const mentionsAssociatedResource = /关联(?:资料|文件|文件集|附件)|文件集|对话附件/u.test(text);
  const namesFile = /[a-z0-9][a-z0-9_.-]*\.[a-z0-9]{1,10}\b/i.test(text);
  const asksResourceLookup = mentionsAssociatedResource
    && namesFile
    && /是否存在|有没有|查找|寻找|核对|确认|读取|查看/u.test(text);
  const exclusiveBasis = /(?:只|仅)(?:需|要)?(?:基于|依据|使用|沿用)/u.test(text);
  const conversationBasis = /(?:当前|本(?:次)?)[\s\S]{0,28}(?:网页)?(?:会话|对话)[\s\S]{0,20}(?:信息|内容|结论|交接|上下文|证据|事实|结果|历史|正文)|(?:当前|本(?:次)?)[\s\S]{0,28}(?:网页)?正文历史|(?:网页)?(?:会话|对话|正文)(?:信息|内容|结论|交接|上下文|证据|事实|结果|历史)/u.test(text);
  const onlyConversation = exclusiveBasis && conversationBasis;
  const prohibitsResource = /(?:不要|无需|不必|禁止)[\s\S]{0,12}(?:读取|查阅|搜索|检索|打开|使用)[\s\S]{0,24}(?:文件|资料|文件集|附件)/u.test(text);
  const prohibitsMemory = /(?:不要|无需|不必|禁止)[\s\S]{0,12}(?:读取|查阅|搜索|检索|使用)[\s\S]{0,24}(?:记忆|memory)/u.test(text);
  const prohibitsSkill = /(?:不要|无需|不必|禁止)[\s\S]{0,12}(?:读取|查阅|搜索|检索|使用)[\s\S]{0,24}(?:skill|技能)/u.test(text);
  const remoteWorkspaceFile = /(?:远端|服务器)[\s\S]{0,10}(?:工作区|目录)[\s\S]{0,12}(?:文件|readme)/u.test(text)
    && !mentionsAssociatedResource;

  const onlyAssociatedResource = asksResourceLookup && !mentionsMemory && !mentionsSkill;
  return Object.freeze({
    memory: !onlyConversation && !prohibitsMemory && !onlyAssociatedResource,
    resources: !onlyConversation && !prohibitsResource && !remoteWorkspaceFile,
    skills: !onlyConversation && !prohibitsSkill && !onlyAssociatedResource,
  });
}
