const VALID_MODES = new Set(["chat", "work"]);

export class WebAgentToolRegistry {
  #tools = new Map();

  register(definition) {
    const name = String(definition?.name || "").trim();
    if (!/^[a-z][a-z0-9_-]{1,80}$/i.test(name)) {
      throw new TypeError("Web Agent tool name is invalid");
    }
    if (this.#tools.has(name)) throw new Error(`Web Agent tool already exists: ${name}`);
    if (typeof definition.execute !== "function") throw new TypeError(`Tool ${name} requires execute()`);
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
      validate: typeof definition.validate === "function" ? definition.validate : (value) => value,
      execute: definition.execute,
      handoff: typeof definition.handoff === "function" ? definition.handoff : null,
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

export function createDefaultWebAgentTools(services) {
  const registry = new WebAgentToolRegistry();
  for (const [name, description, sources] of [
    ["memory_search", "查询当前授权范围内与用户目标相关的长期记忆", ["memory"]],
    ["resource_search", "查询当前对话、项目和已选文件集内的文件内容", ["resources"]],
    ["conversation_search", "查询当前授权范围内的历史对话内容", ["conversation"]],
    ["skill_search", "查询当前用户已安装并可用于任务的 Skill", ["skills"]],
  ]) {
    registry.register({
      name,
      description,
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      validate: (input) => ({
        query: String(input?.query || "").trim(),
        sources,
        limit: Math.min(20, Math.max(1, Number(input?.limit) || 8)),
      }),
      execute: ({ input, actor, scope, signal }) => services.context.search({ actor, scope, ...input, signal }),
      handoff: ({ input, output }) => {
        const source = sources[0];
        let evidence = output?.[source] ?? [];
        if (source === "conversation" && Array.isArray(evidence)) {
          evidence = evidence.slice(-Math.max(1, Number(input?.limit) || 8)).map((message) => ({
            id: message?.id,
            role: message?.role,
            content: message?.content,
            taskId: message?.taskId ?? null,
            createdAt: message?.createdAt,
          }));
        }
        if (source === "skills" && Array.isArray(evidence)) {
          evidence = evidence.map((skill) => ({
            skillId: skill?.skillId,
            version: skill?.version,
            name: skill?.name,
            description: skill?.description,
            entrypoint: skill?.entrypoint,
            permissions: skill?.permissions,
            score: skill?.score,
          }));
        }
        return { source, query: input?.query || "", evidence };
      },
    });
  }
  registry.register({
    name: "context_get_state",
    description: "读取当前对话、项目、服务器、工作区和 Agent 的结构化状态",
    inputSchema: { type: "object", additionalProperties: false },
    execute: ({ actor, scope, signal }) => services.context.state({ actor, scope, signal }),
    handoff: ({ output }) => ({
      source: "current-state",
      evidence: {
        conversation: output?.conversation?.summary ? {
          id: output.conversation.summary.id,
          mode: output.conversation.summary.mode,
          title: output.conversation.summary.title,
          projectId: output.conversation.summary.projectId,
          activeBranchId: output.conversation.summary.activeBranchId,
        } : null,
        project: output?.project || null,
        server: output?.server ? {
          profile: output.server.profile,
          connection: output.server.connection,
          conversationIds: output.server.conversationIds,
        } : null,
        scope: output?.scope || null,
      },
    }),
  });
  return registry;
}
