// Public API for the single Hank agent — everything that defines WHO the agent
// is, as opposed to how a turn executes (that's agent/runtime/). The chat runner
// imports the call params + buildHankSystem + hankTools from here and passes
// them to runAgentTurn: one source of truth for what Hank says and what he can
// call. There is no per-flow switch — one prompt builder, one tool list.
//
// Note the split from the sibling agent/tools/ directory: that holds the tool
// DEFINITIONS (one file per ToolDef); toolset.ts here holds which of them Hank
// is handed.

export { HANK_MODEL, HANK_MAX_TOKENS, HANK_REASONING } from "./call";
export { hankTools, turnCalledHandoffTool } from "./toolset";
export { buildHankSystem } from "./system";
export type { HankSystemPrompt } from "./system";
