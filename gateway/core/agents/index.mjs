export {
  AGENT_EVENT_KINDS,
  AGENT_EVENT_PHASES,
  AGENT_EVENT_SCHEMA_VERSION,
  AGENT_OPERATIONS,
  createAgentState,
  createCapabilitySchema,
  defineAgentAdapter,
} from "./contract.mjs";
export { createOpenCodeAdapter } from "./opencode.mjs";
export { createCodexAdapter } from "./codex.mjs";
export { createClaudeCodeAdapter } from "./claude-code.mjs";

import { createClaudeCodeAdapter } from "./claude-code.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createOpenCodeAdapter } from "./opencode.mjs";

export function createAgentAdapters(options = {}) {
  return Object.freeze({
    opencode: createOpenCodeAdapter(options.opencode),
    codex: createCodexAdapter(options.codex),
    "claude-code": createClaudeCodeAdapter(options["claude-code"]),
  });
}
