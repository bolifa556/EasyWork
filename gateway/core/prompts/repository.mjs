import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";

const WEB_TOOL_NAMES = Object.freeze([
  "resource_search",
  "resource_read",
  "conversation_search",
  "conversation_reference_search",
  "skill_search",
  "handoff_rewrite_candidate",
  "handoff_submit",
]);
const MEMORY_LEVELS = Object.freeze(["user", "project", "conversation"]);

function promptValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

export function renderPromptTemplate(template, variables = {}) {
  const source = String(template || "");
  const expected = [...new Set([...source.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map((match) => match[1]))];
  for (const name of expected) {
    invariant(Object.hasOwn(variables, name), "PROMPT_VARIABLE_REQUIRED", `Prompt 缺少变量 ${name}`, { status: 500, expose: false });
  }
  // Substituted values are data, even when they contain template syntax.
  return source.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, name) => promptValue(variables[name]));
}

export class PromptRepository {
  constructor({ promptRoot }) {
    invariant(path.isAbsolute(promptRoot || ""), "PROMPT_ROOT_INVALID", "promptRoot 必须是绝对路径", { status: 500, expose: false });
    this.promptRoot = path.resolve(promptRoot);
    this.cache = new Map();
  }

  async #read(...segments) {
    const filePath = path.resolve(this.promptRoot, ...segments);
    invariant(filePath.startsWith(`${this.promptRoot}${path.sep}`), "PROMPT_PATH_ESCAPE", "Prompt 路径越界", { status: 500, expose: false });
    const stat = await fs.stat(filePath);
    const cached = this.cache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs) return cached.content;
    const content = await fs.readFile(filePath, "utf8");
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, content });
    return content;
  }

  async #json(...segments) {
    const content = await this.#read(...segments);
    try {
      const parsed = JSON.parse(content);
      invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), "PROMPT_CONFIG_INVALID", "Prompt 配置必须是对象", { status: 500, expose: false });
      return parsed;
    } catch (error) {
      if (error?.code === "PROMPT_CONFIG_INVALID") throw error;
      invariant(false, "PROMPT_CONFIG_INVALID", `Prompt 配置不是有效 JSON：${segments.join("/")}`, { status: 500, expose: false, cause: error });
    }
  }

  async #render(segments, variables) {
    return renderPromptTemplate(await this.#read(...segments), variables);
  }

  async system(mode) {
    invariant(["chat", "work"].includes(mode), "PROMPT_MODE_INVALID", "网页 Agent 模式无效", { status: 400 });
    return (await this.#read("web", mode === "chat" ? "system-chat.md" : "system-work.md")).trim();
  }

  async workRequest(userMessage = "") {
    return (await this.#render(["web", "work-request.md"], {
      USER_MESSAGE: promptValue(userMessage).trim(),
    })).trim();
  }

  async ocrExtraction() {
    return (await this.#read("resources", "ocr-system.md")).trim();
  }

  async ocrInput(label = "") {
    return (await this.#render(["resources", "ocr-input.md"], {
      LABEL: promptValue(label).replace(/\s+/g, " ").trim().slice(0, 260),
    })).trim();
  }

  async resourceSummary({ filename = "", content = "" } = {}) {
    const [system, input] = await Promise.all([
      this.#read("resources", "summary-system.md"),
      this.#render(["resources", "summary-input.md"], {
        FILENAME: promptValue(filename).replace(/\s+/g, " ").trim().slice(0, 4096),
        CONTENT: promptValue(content).trim(),
      }),
    ]);
    return { system: system.trim(), input: input.trim() };
  }

  async skillDiscovery({ name = "", authorDescription = "", entrypoint = "", files = [] } = {}) {
    const [system, input] = await Promise.all([
      this.#read("skills", "discovery-system.md"),
      this.#render(["skills", "discovery-input.md"], {
        NAME: promptValue(name).trim(),
        AUTHOR_DESCRIPTION: promptValue(authorDescription).trim(),
        ENTRYPOINT: promptValue(entrypoint).trim(),
        FILES: (Array.isArray(files) ? files : []).map((file) => `## ${promptValue(file?.path).trim()}\n${promptValue(file?.content).trim()}`).join("\n\n"),
      }),
    ]);
    return { system: system.trim(), input: input.trim() };
  }

  async builtinSkills() {
    const config = await this.#json("skills", "builtins.json");
    invariant(Object.keys(config).length === 1 && Array.isArray(config.skills) && config.skills.length > 0, "BUILTIN_SKILL_PROMPTS_INVALID", "内置 Skill Prompt 不完整", { status: 500, expose: false });
    for (const definition of config.skills) {
      invariant(
        definition && typeof definition === "object" && !Array.isArray(definition)
          && typeof definition.id === "string" && definition.id.trim()
          && typeof definition.skillId === "string" && definition.skillId.trim()
          && typeof definition.name === "string" && definition.name.trim()
          && typeof definition.description === "string" && definition.description.trim()
          && Array.isArray(definition.files) && definition.files.length > 0
          && definition.files.every((file) => typeof file?.path === "string" && file.path.trim() && typeof file.content === "string" && file.content.trim()),
        "BUILTIN_SKILL_PROMPTS_INVALID",
        "内置 Skill Prompt 定义无效",
        { status: 500, expose: false },
      );
    }
    return structuredClone(config.skills);
  }

  async resourceCatalog(entries = []) {
    const config = await this.#json("web", "resource-catalog.json");
    invariant(["document", "empty", "item", "separator"].every((key) => typeof config[key] === "string"), "RESOURCE_CATALOG_PROMPT_INVALID", "文件概览 Prompt 不完整", { status: 500, expose: false });
    const inline = (value, maximum) => promptValue(value).replace(/\s+/g, " ").trim().slice(0, maximum);
    const items = (Array.isArray(entries) ? entries : []).map((entry) => renderPromptTemplate(config.item, {
      FILENAME: inline(entry?.filename, 260),
      SUMMARY: inline(entry?.summary, 380),
    }));
    return renderPromptTemplate(config.document, { ITEMS: items.length ? items.join(config.separator) : config.empty }).trim();
  }

  async skillCatalog(entries = [], mode = "work") {
    invariant(["chat", "work"].includes(mode), "PROMPT_MODE_INVALID", "网页 Agent 模式无效", { status: 400 });
    const config = await this.#json("web", mode === "chat" ? "skill-catalog-chat.json" : "skill-catalog.json");
    invariant(["document", "empty", "item", "separator"].every((key) => typeof config[key] === "string"), "SKILL_CATALOG_PROMPT_INVALID", "Skill 目录 Prompt 不完整", { status: 500, expose: false });
    const inline = (value, maximum) => promptValue(value).replace(/\s+/g, " ").trim().slice(0, maximum);
    const items = (Array.isArray(entries) ? entries : []).map((entry) => renderPromptTemplate(config.item, {
      NAME: inline(entry?.name, 180),
      DESCRIPTION: inline(entry?.discoveryDescription || entry?.description, 500),
      DELIVERY_STATUS: entry?.deliveryState === "delivered" ? "（已发送到当前远端对话，可直接复用）" : "",
      READ_STATUS: entry?.readState === "read" ? "（已读取）" : "",
    }));
    return renderPromptTemplate(config.document, { ITEMS: items.length ? items.join(config.separator) : config.empty }).trim();
  }

  async resourceImageContext(filename) {
    return (await this.#render(["web", "resource-image.md"], { FILENAME: promptValue(filename).replace(/\s+/g, " ").trim().slice(0, 260) })).trim();
  }

  async conversationReferenceCatalog(entries = []) {
    const config = await this.#json("web", "conversation-references.json");
    invariant(["document", "item", "separator"].every((key) => typeof config[key] === "string"), "CONVERSATION_REFERENCE_PROMPT_INVALID", "对话引用 Prompt 不完整", { status: 500, expose: false });
    const inline = (value, maximum) => promptValue(value).replace(/\s+/g, " ").trim().slice(0, maximum);
    const items = (Array.isArray(entries) ? entries : []).map((entry) => renderPromptTemplate(config.item, {
      REFERENCE_ID: inline(entry?.referenceId, 80),
      TITLE: inline(entry?.title, 240),
    }));
    return items.length ? renderPromptTemplate(config.document, { ITEMS: items.join(config.separator) }).trim() : "";
  }

  async webTools() {
    const config = await this.#json("web", "tools.json");
    invariant(config.tools && typeof config.tools === "object" && !Array.isArray(config.tools), "WEB_TOOL_PROMPTS_INVALID", "网页 Agent 工具 Prompt 不完整", { status: 500, expose: false });
    invariant(Object.keys(config).length === 1 && Object.keys(config.tools).length === WEB_TOOL_NAMES.length && Object.keys(config.tools).every((name) => WEB_TOOL_NAMES.includes(name)), "WEB_TOOL_PROMPTS_INVALID", "网页 Agent 工具 Prompt 包含未知配置", { status: 500, expose: false });
    for (const name of WEB_TOOL_NAMES) {
      invariant(
        typeof config.tools[name]?.description === "string" && config.tools[name].description.trim()
          && config.tools[name].inputSchema && typeof config.tools[name].inputSchema === "object",
        "WEB_TOOL_PROMPTS_INVALID",
        `缺少 ${name} 的模型说明或输入 Schema`,
        { status: 500, expose: false },
      );
    }
    return structuredClone(config);
  }

  async webToolPresentation() {
    const config = await this.#json("web", "tool-results.json");
    const observationTemplates = [
      "toolUnavailable",
      "invalidToolArguments",
      "invalidToolInput",
      "toolFailure",
      "observationWorkHeading",
      "observationChatHeading",
      "observationCandidate",
      "observationItem",
      "observationMemoryItem",
      "observationDefaultKind",
      "observationDefaultName",
      "conversationReferenceHeading",
      "conversationReferenceMemorySection",
      "conversationReferenceRecentSection",
      "conversationReferenceMatchesSection",
    ];
    invariant(
      typeof config.emptyResult === "string"
        && typeof config.failedResult === "string"
        && typeof config.sectionSeparator === "string"
        && typeof config.truncationSuffix === "string"
        && observationTemplates.every((key) => typeof config[key] === "string" && config[key].trim()),
      "WEB_TOOL_RESULT_PROMPTS_INVALID",
      "网页 Agent 工具结果模板不完整",
      { status: 500, expose: false },
    );
    return structuredClone(config);
  }

  async webToolResult(kind, variables = {}) {
    const config = await this.webToolPresentation();
    const template = config[kind];
    invariant(typeof template === "string", "WEB_TOOL_RUNTIME_PROMPT_INVALID", `网页 Agent 缺少 ${kind} 结果模板`, { status: 500, expose: false });
    return renderPromptTemplate(template, variables);
  }

  async memoryTools(availableLevels = []) {
    const config = await this.#json("memory", "tools.json");
    invariant(Object.keys(config).length === MEMORY_LEVELS.length && Object.keys(config).every((level) => MEMORY_LEVELS.includes(level)), "MEMORY_TOOL_PROMPTS_INVALID", "记忆工具定义包含未知范围", { status: 500, expose: false });
    const allowed = new Set((Array.isArray(availableLevels) ? availableLevels : []).map(promptValue));
    const tools = [];
    for (const level of MEMORY_LEVELS) {
      if (!allowed.has(level)) continue;
      const definition = config[level];
      invariant(
        definition?.name === `remember_${level}`
          && typeof definition.description === "string" && definition.description.trim()
          && definition.inputSchema && typeof definition.inputSchema === "object",
        "MEMORY_TOOL_PROMPTS_INVALID",
        `缺少 ${level} 记忆工具定义`,
        { status: 500, expose: false },
      );
      tools.push(structuredClone(definition));
    }
    return tools;
  }

  async memoryExtraction({ userMessage = "", assistantMessage = "" } = {}) {
    const [system, input] = await Promise.all([
      this.#read("memory", "persistent-memory-extract.md"),
      this.#render(["memory", "persistent-memory-extract-input.md"], {
        USER_MESSAGE: promptValue(userMessage).trim(),
        ASSISTANT_MESSAGE: promptValue(assistantMessage).trim(),
      }),
    ]);
    return { system: system.trim(), input: input.trim() };
  }

  async checkpointText(summary) {
    if (typeof summary === "string") return summary.trim();
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "";
    return [...new Set(Object.values(summary).flatMap((value) => (
      Array.isArray(value) ? value : typeof value === "string" ? [value] : []
    )).map(promptValue).map((value) => value.trim()).filter(Boolean))].join("\n");
  }

  async conversationMessage(role, content) {
    const config = await this.#json("context", "conversation.json");
    const template = config.roles?.[role] || config.roles?.message;
    invariant(typeof template === "string", "CONVERSATION_PROMPT_ROLE_INVALID", "对话 Prompt 缺少角色模板", { status: 500, expose: false });
    return renderPromptTemplate(template, { CONTENT: promptValue(content).trim() });
  }

  async conversationTranscript(messages) {
    const config = await this.#json("context", "conversation.json");
    const rendered = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const content = promptValue(message?.content).trim();
      if (!content) continue;
      rendered.push(await this.conversationMessage(message?.role, content));
    }
    return rendered.join(promptValue(config.separator));
  }

  async contextLayout() {
    const config = await this.#json("context", "layout.json");
    invariant(
      Object.keys(config).length === 2
        && typeof config.systemMessageSeparator === "string" && config.systemMessageSeparator.length > 0
        && typeof config.remoteDeliverySeparator === "string" && config.remoteDeliverySeparator.length > 0,
      "CONTEXT_LAYOUT_PROMPT_INVALID",
      "模型上下文布局 Prompt 无效",
      { status: 500, expose: false },
    );
    return structuredClone(config);
  }

  async conversationCompact({ existingCheckpoint = null, messages = [] } = {}) {
    const [checkpoint, transcript] = await Promise.all([
      this.checkpointText(existingCheckpoint),
      this.conversationTranscript(messages),
    ]);
    const priorSummaryBlock = checkpoint
      ? await this.#render(["memory", "conversation-compact-prior.md"], { EXISTING_CHECKPOINT: checkpoint })
      : "";
    const [system, input] = await Promise.all([
      this.#read("memory", "conversation-compact.md"),
      this.#render(["memory", "conversation-compact-input.md"], {
        PRIOR_SUMMARY_BLOCK: priorSummaryBlock,
        MESSAGES: transcript,
      }),
    ]);
    return { system: system.trim(), input: input.trim() };
  }

  async conversationTitle({ userPrompt = "", assistantResponse = "" } = {}) {
    const [system, input] = await Promise.all([
      this.#read("tasks", "conversation-title.md"),
      this.#render(["tasks", "conversation-title-input.md"], {
        USER_PROMPT: promptValue(userPrompt).trim(),
        ASSISTANT_RESPONSE: promptValue(assistantResponse).trim(),
      }),
    ]);
    return { system: system.trim(), input: input.trim() };
  }

  async remoteTask({ userMessage = "" } = {}) {
    return promptValue(userMessage).trim();
  }

  async remoteDelivery(delivery, goal) {
    const layout = await this.contextLayout();
    const request = promptValue(goal).replace(/\r\n/g, "\n").trim();
    const currentUserLine = await this.conversationMessage("user", request);
    const sections = [];
    const history = [];
    const seen = new Set();
    for (const entry of delivery?.entries || []) {
      if (entry?.content?.format === "json" || entry?.kind === "task" || entry?.source?.type === "task") continue;
      const value = promptValue(entry?.content?.value).trim();
      if (entry?.source?.type === "conversation") {
        // Equal text in different historical turns is still distinct history,
        // including a previous user message identical to the current request.
        if (value) history.push(value);
        continue;
      }
      if (!value || value === request || value === currentUserLine || seen.has(value)) continue;
      seen.add(value);
      sections.push(value);
    }
    if (!sections.length && !history.length) return request;
    const [contextText, historyText] = await Promise.all([
      sections.length ? this.#render(["context", "remote-retrieved.md"], { CONTEXT: sections.join(layout.remoteDeliverySeparator) }) : "",
      history.length ? this.#render(["context", "remote-history.md"], { HISTORY: history.join(layout.remoteDeliverySeparator) }) : "",
    ]);
    return (await this.#render(["context", "remote-delivery.md"], {
      CONTEXT: contextText.trim(),
      HISTORY: historyText.trim(),
      USER_MESSAGE: request,
    })).trim();
  }

}
