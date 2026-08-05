import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import { listMemoriesTool } from "@/server/agent/tools/registry/listMemories";
import { readMemoryTool } from "@/server/agent/tools/registry/readMemory";

// Default read-only toolset shared with every sub-agent that gets read tools at
// all. Extend by composing — e.g. `[...SUB_AGENT_READ_TOOLS, pastClosedJobsTool]`
// — rather than mutating this array. A sub-agent's read tools are ordinary
// `ToolDef`s from the tool registry, just left out of `hankToolsFor`.
export const SUB_AGENT_READ_TOOLS: AnyToolDef[] = [
  readMemoryTool as AnyToolDef,
  listMemoriesTool as AnyToolDef,
];
