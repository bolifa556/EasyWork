import crypto from "node:crypto";

const VALID_MODES = new Set(["chat", "work"]);
const STATE_FIELDS = new Set(["conversation", "project", "server", "workspace", "agent"]);
const MAX_PRESENTED_CHARACTERS = 24_000;
const MAX_HANDOFF_CHARACTERS = 48_000;

function nonEmptyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values) {
  return [...new Set(values.map(nonEmptyText).filter(Boolean))];
}

function stableFactAnchors(value) {
  const matches = String(value || "").normalize("NFKC").match(/[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)+|\b\d{2,}(?:\.\d+)?\b/gu) || [];
  return [...new Set(matches.map((entry) => entry.toLocaleLowerCase("en-US")))].sort();
}

function deduplicateMemoryContents(contents) {
  const selected = [];
  const anchored = new Map();
  for (const content of contents) {
    const anchors = stableFactAnchors(content);
    if (!anchors.length) {
      selected.push(content);
      continue;
    }
    const key = anchors.join("\0");
    const existingIndex = anchored.get(key);
    if (existingIndex === undefined) {
      anchored.set(key, selected.length);
      selected.push(content);
      continue;
    }
    if (content.length > selected[existingIndex].length) selected[existingIndex] = content;
  }
  return selected;
}

const semanticDigest = (value) => crypto.createHash("sha256").update(String(value || "").replace(/\r\n/g, "\n").trim()).digest("hex");

function clippedText(value, limit = MAX_PRESENTED_CHARACTERS, truncationSuffix = "") {
  if (limit <= 0) return "";
  const text = nonEmptyText(value);
  if (text.length <= limit) return text;
  const suffix = String(truncationSuffix || "");
  return `${text.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

function withinTextBudget(entries, textOf, limit = MAX_PRESENTED_CHARACTERS, truncationSuffix = "") {
  const selected = [];
  let remaining = limit;
  for (const entry of entries) {
    if (remaining <= 0) break;
    const text = clippedText(textOf(entry), remaining, truncationSuffix);
    if (!text) continue;
    selected.push({ entry, text });
    remaining -= text.length;
  }
  return selected;
}

function semanticMemory(entries, formatting) {
  const contents = deduplicateMemoryContents(uniqueStrings((Array.isArray(entries) ? entries : []).map((entry) => (
    typeof entry === "string" ? entry : entry?.content?.value ?? entry?.content ?? entry?.text ?? ""
  ))));
  return withinTextBudget(contents, (content) => content, MAX_PRESENTED_CHARACTERS, formatting.truncationSuffix).map(({ text: content }) => ({ content }));
}

function semanticResources(entries, formatting) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const filename = nonEmptyText(entry?.filename ?? entry?.name ?? entry?.path);
    const text = nonEmptyText(entry?.text ?? entry?.content?.value ?? entry?.content);
    if (!filename && !text) continue;
    const key = `${filename}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nextOffset = entry?.nextOffset !== null && entry?.nextOffset !== undefined && Number.isSafeInteger(Number(entry.nextOffset)) && Number(entry.nextOffset) >= 0
      ? Number(entry.nextOffset)
      : null;
    result.push({ ...(filename ? { filename } : {}), ...(text ? { text } : {}), ...(nextOffset !== null ? { nextOffset } : {}) });
  }
  return withinTextBudget(result, (entry) => [entry.filename, entry.text].filter(Boolean).join(formatting.fieldSeparator), MAX_PRESENTED_CHARACTERS, formatting.truncationSuffix)
    .map(({ entry, text }) => {
      const filename = clippedText(entry.filename, text.length, formatting.truncationSuffix);
      const bodyLimit = Math.max(0, text.length - filename.length - (filename && entry.text ? 1 : 0));
      const body = clippedText(entry.text, bodyLimit, formatting.truncationSuffix);
      return { ...(filename ? { filename } : {}), ...(body ? { text: body } : {}), ...(entry.nextOffset !== undefined ? { nextOffset: entry.nextOffset } : {}) };
    });
}

function semanticConversation(entries, limit, formatting) {
  const selected = (Array.isArray(entries) ? entries : []).slice(0, limit);
  const seen = new Set();
  const result = [];
  for (const entry of selected) {
    const content = nonEmptyText(typeof entry === "string" ? entry : entry?.content ?? entry?.text);
    if (!content) continue;
    const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : "message";
    const key = `${role}\0${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ role, content });
  }
  return withinTextBudget(result, (entry) => entry.content, MAX_PRESENTED_CHARACTERS, formatting.truncationSuffix)
    .map(({ entry, text: content }) => ({ role: entry.role, content }));
}

function semanticSkills(entries, formatting) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = nonEmptyText(entry?.name ?? entry?.displayName);
    const description = nonEmptyText(entry?.description);
    const files = Array.isArray(entry?.files) ? entry.files : [];
    const entrypoint = nonEmptyText(entry?.entrypoint);
    const primaryFiles = files.filter((file) => {
      const path = nonEmptyText(file?.path).replaceAll("\\", "/");
      return path === entrypoint || path === "SKILL.md";
    });
    const instructions = uniqueStrings((primaryFiles.length ? primaryFiles : files.slice(0, 1))
      .map((file) => file?.content));
    if (!name && !description && !instructions.length) continue;
    const key = `${name}\0${description}\0${instructions.join("\0")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(instructions.length ? { instructions } : {}),
    });
  }
  return withinTextBudget(result, (entry) => [entry.name, entry.description, ...(entry.instructions || [])].filter(Boolean).join(formatting.fieldSeparator), MAX_PRESENTED_CHARACTERS, formatting.truncationSuffix)
    .map(({ entry, text }) => {
      let remaining = text.length;
      const name = clippedText(entry.name, remaining, formatting.truncationSuffix);
      remaining -= name.length;
      const description = clippedText(entry.description, remaining, formatting.truncationSuffix);
      remaining -= description.length;
      const instructions = withinTextBudget(entry.instructions || [], (value) => value, remaining, formatting.truncationSuffix).map((item) => item.text);
      return {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(instructions.length ? { instructions } : {}),
      };
    });
}

function semanticSkillSummaries(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const name = nonEmptyText(entry?.name ?? entry?.displayName);
    const description = nonEmptyText(entry?.description);
    const key = `${name}\0${description}`;
    if ((!name && !description) || seen.has(key)) return [];
    seen.add(key);
    return [{ ...(name ? { name } : {}), ...(description ? { description } : {}) }];
  }).slice(0, 50);
}

function semanticSearchResult(source, output, limit, formatting) {
  const entries = output?.[source] ?? [];
  if (source === "memory") return { memory: semanticMemory(entries, formatting) };
  if (source === "resources") return { resources: semanticResources(entries, formatting) };
  if (source === "conversation") return { conversation: semanticConversation(entries, limit, formatting) };
  if (source === "skills") return { skills: semanticSkills(entries, formatting) };
  return {};
}

function semanticState(output, requestedFields = [...STATE_FIELDS]) {
  const fields = new Set(requestedFields);
  const state = {};
  const conversation = output?.conversation?.summary ?? output?.conversation;
  const conversationTitle = nonEmptyText(conversation?.title);
  if (fields.has("conversation") && conversationTitle) state.conversation = { title: conversationTitle };
  const projectName = nonEmptyText(output?.project?.name);
  if (fields.has("project") && projectName) state.project = { name: projectName };
  const serverName = nonEmptyText(output?.server?.profile?.name ?? output?.server?.profile?.host);
  const serverStatus = nonEmptyText(output?.server?.connection?.status);
  const schedulerFeature = output?.serverCapabilities?.features?.scheduler;
  const schedulerType = nonEmptyText(schedulerFeature?.type);
  const scheduler = ["slurm", "pbs", "generic"].includes(schedulerType)
    ? schedulerType
    : schedulerFeature?.status === "unavailable" && schedulerType === "none"
      ? "none"
      : schedulerFeature
        ? "unknown"
        : "";
  if (fields.has("server") && (serverName || serverStatus)) {
    state.server = {
      ...(serverName ? { name: serverName } : {}),
      ...(serverStatus ? { status: serverStatus } : {}),
      ...(scheduler ? { scheduler } : {}),
    };
  }
  const workspacePath = nonEmptyText(output?.workspace?.path ?? output?.workspace?.canonicalPath);
  if (fields.has("workspace") && workspacePath) state.workspace = { path: workspacePath };
  const agentName = nonEmptyText(output?.agent?.displayName ?? output?.agent?.name);
  if (fields.has("agent") && agentName) state.agent = { name: agentName };
  return state;
}

function indented(value, templates) {
  return nonEmptyText(value).replace(/\n/g, `${templates.fieldSeparator}${templates.continuationIndent}`);
}

async function renderSemanticContext(output, prompts, options = {}) {
  const templates = await prompts.webToolPresentation();
  const sections = [];
  if (Array.isArray(output?.memory) && output.memory.length) {
    const items = output.memory.map((entry) => entry?.content).map(nonEmptyText).filter(Boolean)
      .map((content) => templates.listItem.replace("{{ITEM}}", indented(content, templates))).join(templates.itemSeparator);
    if (items) sections.push(templates.memorySection.replace("{{ITEMS}}", items));
  }
  if (Array.isArray(output?.resources) && output.resources.length) {
    const lines = output.resources.map((entry) => {
      const filename = nonEmptyText(entry?.filename);
      const content = indented(entry?.text, templates);
      if (filename && content) return templates.resourceWithContent.replace("{{FILENAME}}", filename).replace("{{CONTENT}}", content);
      return templates.listItem.replace("{{ITEM}}", filename || content);
    }).filter((line) => line !== templates.listItem.replace("{{ITEM}}", ""));
    if (lines.length) sections.push(templates.resourcesSection.replace("{{ITEMS}}", lines.join(templates.itemSeparator)));
  }
  if (Array.isArray(output?.conversation) && output.conversation.length) {
    const lines = output.conversation
      .map((entry) => (templates.conversationItem?.[entry?.role] || templates.conversationItem?.message || "")
        .replace("{{CONTENT}}", indented(entry?.content, templates)))
      .filter((line) => line && !line.endsWith("："));
    if (lines.length) sections.push(templates.conversationSection.replace("{{ITEMS}}", lines.join(templates.itemSeparator)));
  }
  if (Array.isArray(output?.skills) && output.skills.length) {
    const lines = output.skills.map((entry) => {
      const heading = [nonEmptyText(entry?.name), nonEmptyText(entry?.description)].filter(Boolean).join(templates.headingSeparator);
      const instructions = (Array.isArray(entry?.instructions) ? entry.instructions : []).map((value) => indented(value, templates)).filter(Boolean).join(`${templates.fieldSeparator}${templates.continuationIndent}`);
      return templates.skillItem.replace("{{HEADING}}", heading).replace("{{INSTRUCTIONS}}", instructions ? `${heading ? templates.skillInstructionPrefix : ""}${instructions}` : "");
    }).filter((line) => line !== templates.skillItem.replace("{{HEADING}}", "").replace("{{INSTRUCTIONS}}", ""));
    if (lines.length) sections.push(templates.skillsSection.replace("{{ITEMS}}", lines.join(templates.itemSeparator)));
  }
  const stateLines = [];
  if (output?.conversation?.title) stateLines.push(templates.stateItem.conversation.replace("{{VALUE}}", indented(output.conversation.title, templates)));
  if (output?.project?.name) stateLines.push(templates.stateItem.project.replace("{{VALUE}}", indented(output.project.name, templates)));
  if (output?.server) {
    const status = templates.serverStatuses?.[output.server.status] || nonEmptyText(output.server.status);
    const name = nonEmptyText(output.server.name);
    let value = name && status
      ? templates.serverNameStatus.replace("{{NAME}}", name).replace("{{STATUS}}", status)
      : name || status;
    const scheduler = templates.schedulerTypes?.[output.server.scheduler] || nonEmptyText(output.server.scheduler);
    if (value && scheduler) value = templates.serverWithScheduler.replace("{{VALUE}}", value).replace("{{SCHEDULER}}", scheduler);
    if (value) stateLines.push(templates.stateItem.server.replace("{{VALUE}}", value));
  }
  if (output?.workspace?.path) stateLines.push(templates.stateItem.workspace.replace("{{VALUE}}", indented(output.workspace.path, templates)));
  if (output?.agent?.name) stateLines.push(templates.stateItem.agent.replace("{{VALUE}}", indented(output.agent.name, templates)));
  if (stateLines.length) sections.push(templates.stateSection.replace("{{ITEMS}}", stateLines.join(templates.itemSeparator)));
  const limit = Number.isFinite(options.maxCharacters) && options.maxCharacters > 0
    ? Number(options.maxCharacters)
    : MAX_HANDOFF_CHARACTERS;
  return clippedText(sections.join(templates.sectionSeparator), limit, templates.truncationSuffix);
}

function knowledgeForSearchResult(source, entry, presented) {
  if (source === "memory") {
    const content = nonEmptyText(typeof entry === "string"
      ? entry
      : entry?.content?.value ?? entry?.content ?? entry?.text)
      || nonEmptyText(presented?.memory?.[0]?.content);
    const sourceId = nonEmptyText(entry?.source?.id ?? entry?.recordId ?? entry?.semanticKey ?? entry?.id) || `content:${semanticDigest(content)}`;
    const sourceVersion = nonEmptyText(entry?.source?.version ?? entry?.version?.id ?? entry?.version) || semanticDigest(content);
    return { key: `memory:${sourceId}`, version: sourceVersion, content };
  }
  if (source === "resources") {
    const item = presented?.resources?.[0] || {};
    // The remote Agent receives the selected semantic evidence, not a claim
    // that the source file exists in its workspace.  Keep the filename only
    // in the user-visible reference and the private de-duplication identity.
    const content = nonEmptyText(entry?.text ?? entry?.content?.value ?? entry?.content)
      || nonEmptyText(item.text);
    const resourceId = nonEmptyText(entry?.resourceId ?? entry?.resourceVersionId ?? item.filename) || `content:${semanticDigest(content)}`;
    const chunkId = nonEmptyText(entry?.chunkId) || `content:${semanticDigest(item.text || content)}`;
    const sourceVersion = nonEmptyText(entry?.resourceVersionId ?? entry?.version?.id ?? entry?.version) || semanticDigest(content);
    // A direct read from offset zero with no continuation is the complete
    // immutable file version. Record that stronger coverage identity so later
    // semantic searches cannot surface another chunk from the same file to the
    // same native Agent conversation. Partial reads and search hits remain
    // chunk-scoped because a later request may legitimately need another part.
    const completeFileRead = chunkId === "read_0"
      && (entry?.nextOffset === null || entry?.nextOffset === undefined);
    return {
      key: completeFileRead ? `resource:${resourceId}:file` : `resource:${resourceId}:${chunkId}`,
      version: sourceVersion,
      content,
    };
  }
  if (source === "skills") {
    const item = presented?.skills?.[0] || {};
    const files = Array.isArray(entry?.files) ? entry.files : [];
    const entrypoint = nonEmptyText(entry?.entrypoint);
    const primaryFiles = files.filter((file) => {
      const path = nonEmptyText(file?.path).replaceAll("\\", "/");
      return path === entrypoint || path === "SKILL.md";
    });
    const rawInstructions = uniqueStrings((primaryFiles.length ? primaryFiles : files.slice(0, 1))
      .map((file) => file?.content));
    const content = [
      nonEmptyText(entry?.name ?? entry?.displayName) || nonEmptyText(item.name),
      nonEmptyText(entry?.description) || nonEmptyText(item.description),
      ...(rawInstructions.length
        ? rawInstructions
        : Array.isArray(item.instructions) ? item.instructions.map(nonEmptyText) : []),
    ].filter(Boolean).join("\n");
    const skillId = nonEmptyText(entry?.skillId ?? entry?.id ?? item.name) || `content:${semanticDigest(content)}`;
    const sourceVersion = [nonEmptyText(entry?.version), nonEmptyText(entry?.sha256)].filter(Boolean).join(":") || semanticDigest(content);
    // semantic-v1 marks the point at which selected Skill instructions became
    // part of the ContextHub delivery itself.  Older receipts only proved the
    // package was deployed, so they must not suppress this first real handoff.
    return { key: `skill:${skillId}`, version: `semantic-v1:${sourceVersion}`, content };
  }
  const content = nonEmptyText(JSON.stringify(presented || {}));
  return { key: `${source}:content:${semanticDigest(content)}`, version: semanticDigest(content), content };
}

export async function conversationKnowledgeUnit(entry, prompts) {
  const rawContent = nonEmptyText(typeof entry === "string" ? entry : entry?.content ?? entry?.text);
  if (!rawContent) return null;
  const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : "system";
  const content = await prompts.conversationMessage(role, rawContent);
  const messageId = nonEmptyText(entry?.id);
  const identity = messageId || `content:${semanticDigest(content)}`;
  return { key: `conversation:${identity}`, version: identity, content };
}

function pruneObservedSearchResults(source, output, observedFragments, formatting) {
  const known = new Set((Array.isArray(observedFragments) ? observedFragments : []).flatMap((fragment) => {
    const key = nonEmptyText(fragment?.knowledge?.key);
    const version = nonEmptyText(fragment?.knowledge?.version);
    return key && version ? [`${key}\0${version}`] : [];
  }));
  if (!known.size) return { output, allObserved: false };
  const entries = Array.isArray(output?.[source]) ? output[source] : [];
  const filtered = entries.filter((entry) => {
    const presented = semanticSearchResult(source, { [source]: [entry] }, 1, formatting);
    const knowledge = knowledgeForSearchResult(source, entry, presented);
    return !known.has(`${knowledge.key}\0${knowledge.version}`);
  });
  if (filtered.length === entries.length) return { output, allObserved: false };
  return {
    output: {
      ...(output && typeof output === "object" ? output : {}),
      [source]: filtered,
      ...(source === "resources" && !filtered.length ? { modelImages: [] } : {}),
    },
    allObserved: entries.length > 0 && filtered.length === 0,
  };
}

function handoffReference(source, entry, presented) {
  if (source === "memory") {
    return { kind: "记忆", name: nonEmptyText(entry?.semanticKey) || "相关记忆" };
  }
  if (source === "resources") {
    const item = presented?.resources?.[0] || {};
    return { kind: "文件", name: nonEmptyText(item.filename ?? entry?.filename ?? entry?.name ?? entry?.path) || "相关文件" };
  }
  if (source === "skills") {
    const item = presented?.skills?.[0] || {};
    return { kind: "Skill", name: nonEmptyText(item.name ?? entry?.name ?? entry?.displayName) || "已选 Skill" };
  }
  return null;
}

async function semanticHandoffItems(source, output, formatting, prompts, toolName) {
  const entries = Array.isArray(output?.[source]) ? output[source] : [];
  const items = [];
  for (const entry of entries) {
    const presented = semanticSearchResult(source, { [source]: [entry] }, 1, formatting);
    const rendered = await renderSemanticContext(presented, prompts);
    if (!rendered) continue;
    const knowledge = source === "conversation"
      ? await conversationKnowledgeUnit(entry, prompts)
      : knowledgeForSearchResult(source, entry, presented);
    if (!knowledge) continue;
    items.push({
      toolName,
      rendered,
      presented,
      knowledge,
      reference: handoffReference(source, entry, presented),
      priority: source === "skills" ? 100 : source === "resources" ? 90 : 80,
    });
  }
  return items;
}

export class WebAgentToolRegistry {
  #tools = new Map();

  register(definition) {
    const name = String(definition?.name || "").trim();
    if (!/^[a-z][a-z0-9_-]{1,80}$/i.test(name)) {
      throw new TypeError("Web Agent tool name is invalid");
    }
    if (this.#tools.has(name)) throw new Error(`Web Agent tool already exists: ${name}`);
    if (typeof definition.execute !== "function") throw new TypeError(`Tool ${name} requires execute()`);
    if (typeof definition.present !== "function" || typeof definition.render !== "function") {
      throw new TypeError(`Tool ${name} requires explicit semantic present() and render()`);
    }
    const modes = [...new Set(definition.modes || ["chat", "work"])];
    if (!modes.length || modes.some((mode) => !VALID_MODES.has(mode))) {
      throw new TypeError(`Tool ${name} has invalid modes`);
    }
    const normalized = Object.freeze({
      name,
      description: String(definition.description || "").trim(),
      inputSchema: definition.inputSchema || { type: "object", additionalProperties: false },
      modes,
      mutating: Boolean(definition.mutating),
      terminal: Boolean(definition.terminal),
      handoff: definition.handoff !== false,
      timelineRead: Boolean(definition.timelineRead),
      validate: typeof definition.validate === "function" ? definition.validate : (value) => value,
      execute: definition.execute,
      prune: typeof definition.prune === "function"
        ? definition.prune
        : ({ output }) => ({ output, allObserved: false }),
      present: definition.present,
      render: (presented) => definition.render(presented),
      handoffItems: typeof definition.handoffItems === "function"
        ? definition.handoffItems
        : async ({ presented, rendered }) => rendered ? [{ toolName: name, rendered, presented }] : [],
      modelMessages: typeof definition.modelMessages === "function" ? definition.modelMessages : async () => [],
    });
    this.#tools.set(name, normalized);
    return this;
  }

  definitions(mode) {
    if (!VALID_MODES.has(mode)) throw new TypeError("Unknown Web Agent mode");
    return [...this.#tools.values()]
      .filter((tool) => tool.modes.includes(mode))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  resolve(name, mode) {
    const tool = this.#tools.get(name);
    if (!tool || !tool.modes.includes(mode)) return null;
    return tool;
  }
}

export async function createDefaultWebAgentTools(services, prompts, {
  workMemoryTools = true,
  workResourceTools = true,
  workSkillTools = true,
} = {}) {
  if (!prompts || typeof prompts.webTools !== "function") throw new TypeError("Web Agent prompt repository is required");
  const [promptConfig, formatting] = await Promise.all([prompts.webTools(), prompts.webToolPresentation()]);
  const registry = new WebAgentToolRegistry();
  const memoryModes = workMemoryTools ? ["chat", "work"] : ["chat"];
  const resourceModes = workResourceTools ? ["chat", "work"] : ["chat"];
  const skillModes = workSkillTools ? ["chat", "work"] : ["chat"];
  const conversationModes = ["chat"];
  for (const [name, sources, modes] of [
    ["memory_search", ["memory"], memoryModes],
    ["resource_search", ["resources"], resourceModes],
    ["conversation_search", ["conversation"], conversationModes],
  ]) {
    registry.register({
      name,
      description: promptConfig.tools[name].description,
      modes,
      timelineRead: true,
      inputSchema: promptConfig.tools[name].inputSchema,
      validate: (input) => {
        const query = String(input?.query || "").trim();
        if (!query) throw new TypeError("query is required");
        if (name !== "conversation_search") return { query };
        const roles = uniqueStrings(Array.isArray(input?.roles) ? input.roles : [])
          .filter((role) => ["system", "user", "assistant"].includes(role));
        return {
          query,
          ...(roles.length ? { roles } : {}),
        };
      },
      execute: ({ input, actor, scope, signal }) => services.context.search({
        actor,
        scope,
        query: input.query,
        // Conversation results are over-fetched so the native receipt filter
        // runs before the requested visible-candidate limit is applied.
        limit: 8,
        sources,
        ...(input.roles ? { roles: input.roles } : {}),
        signal,
      }),
      prune: ({ output, observedFragments }) => pruneObservedSearchResults(sources[0], output, observedFragments, formatting),
      present: ({ output }) => semanticSearchResult(sources[0], output, 8, formatting),
      render: (presented) => renderSemanticContext(presented, prompts),
      handoffItems: ({ output }) => semanticHandoffItems(sources[0], output, formatting, prompts, name),
    });
  }
  registry.register({
    name: "resource_read",
    description: promptConfig.tools.resource_read.description,
    modes: resourceModes,
    timelineRead: true,
    inputSchema: promptConfig.tools.resource_read.inputSchema,
    validate: (input) => {
      const filename = String(input?.filename || "").normalize("NFKC").trim();
      const start = Number(input?.start ?? 0);
      if (!filename) throw new TypeError("filename is required");
      if (!Number.isSafeInteger(start) || start < 0) throw new TypeError("start must be a non-negative integer");
      return { filename, start };
    },
    execute: ({ input, actor, scope, signal }) => services.context.readResource({ actor, scope, filename: input.filename, start: input.start, signal }),
    prune: ({ output, observedFragments }) => pruneObservedSearchResults("resources", output, observedFragments, formatting),
    present: ({ output }) => semanticSearchResult("resources", output, 5, formatting),
    render: async (presented) => {
      const content = await renderSemanticContext(presented, prompts);
      const continuations = await Promise.all((presented.resources || []).filter((entry) => entry.nextOffset !== undefined).map((entry) => prompts.webToolResult("resourceContinuation", {
        FILENAME: entry.filename || "文件",
        NEXT_OFFSET: entry.nextOffset,
      })));
      return [content, ...continuations].filter(Boolean).join(formatting.sectionSeparator);
    },
    handoffItems: ({ output }) => semanticHandoffItems("resources", output, formatting, prompts, "resource_read"),
    modelMessages: async ({ output }) => Promise.all((output?.modelImages || []).map(async (image) => ({
      role: "user",
      content: [
        { type: "text", text: await prompts.resourceImageContext(image.filename) },
        { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } },
      ],
    }))),
  });
  registry.register({
    name: "skill_search",
    description: promptConfig.tools.skill_search.description,
    modes: skillModes,
    timelineRead: true,
    inputSchema: promptConfig.tools.skill_search.inputSchema,
    validate: (input) => {
      const name = String(input?.name || "").trim();
      const query = String(input?.query || "").trim();
      if (!name) throw new TypeError("name is required");
      if (!query) throw new TypeError("query is required");
      return { name, query };
    },
    execute: ({ input, actor, signal }) => services.skills.read({ actor, name: input.name, query: input.query, signal }),
    prune: ({ output, observedFragments }) => pruneObservedSearchResults("skills", output, observedFragments, formatting),
    present: ({ output }) => semanticSearchResult("skills", output, 1, formatting),
    render: (presented) => renderSemanticContext(presented, prompts),
    handoffItems: ({ output }) => semanticHandoffItems("skills", output, formatting, prompts, "skill_search"),
  });
  registry.register({
    name: "skill_list",
    description: promptConfig.tools.skill_list.description,
    modes: skillModes,
    handoff: false,
    inputSchema: promptConfig.tools.skill_list.inputSchema,
    validate: () => ({}),
    execute: ({ actor, signal }) => services.skills.list({ actor, signal }),
    present: ({ output }) => ({ skills: semanticSkillSummaries(output?.skills ?? output?.items ?? output) }),
    render: (presented) => renderSemanticContext(presented, prompts),
  });
  registry.register({
    name: "context_get_state",
    description: promptConfig.tools.context_get_state.description,
    modes: ["chat"],
    handoff: false,
    timelineRead: false,
    inputSchema: promptConfig.tools.context_get_state.inputSchema,
    validate: (input) => {
      const fields = uniqueStrings(Array.isArray(input?.fields) ? input.fields : []).filter((field) => STATE_FIELDS.has(field));
      if (!fields.length) throw new TypeError("fields is required");
      return { fields };
    },
    execute: ({ actor, scope, input, signal }) => services.context.state({ actor, scope, fields: input.fields, signal }),
    present: ({ input, output }) => semanticState(output, input.fields),
    render: (presented) => renderSemanticContext(presented, prompts),
  });
  registry.register({
    name: "handoff_submit",
    description: promptConfig.tools.handoff_submit.description,
    modes: ["work"],
    terminal: true,
    handoff: false,
    inputSchema: promptConfig.tools.handoff_submit.inputSchema,
    validate: (input) => {
      if (!Array.isArray(input?.candidateIds)) throw new TypeError("candidateIds is required");
      return { candidateIds: uniqueStrings(input.candidateIds).slice(0, 128) };
    },
    execute: async ({ input }) => ({ candidateIds: input.candidateIds }),
    present: ({ output }) => ({ candidateIds: [...(output?.candidateIds || [])] }),
    render: async () => "",
  });
  return registry;
}

export { renderSemanticContext, semanticSearchResult, semanticState };
