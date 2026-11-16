// The tool contract the agent loop (runAgentTurn) dispatches against — generic
// over the two things it carries without reading: the panel events a tool emits
// (`TUi`) and whatever extra outcome fields the product puts on a result. The
// product's own tool types narrow this in src/server/tools/lib/types.ts; this
// file names no product concept.

import type { RunContext } from "@/server/platform/runContext";

import type { ToolError } from "./toolError";
import type { z } from "zod";

// A tool handler's context IS the ambient RunContext — a tool dispatch is just
// one more place work runs for a user. `runAgentTurn` assembles it once per
// dispatch, setting `trace.parentToolUseId` to this tool's own tool_use_id so
// anything it spawns nests under its chip. A handler forwards it verbatim
// (`{ ...ctx, companyId }`) into whatever it calls.
//
// `sessionId` is required here and optional on RunContext: a tool only ever runs
// inside a chat dispatch.
export type ToolContext = RunContext & {
  sessionId: string;
};

// A widget a tool wants rendered on top of its content. The loop yields each as
// a `pipeline_widget` event and hands them back for the caller to persist.
export type AgentToolWidget<TKind extends string = string> = {
  kind: TKind;
  toolUseId: string;
  payload: unknown;
};

// What the loop reads off a result: `content` (and `error`) for the model,
// `events` / `widgets` / `statusLines` for the screen. Anything else a product
// adds rides along untouched and comes back in `AgentTurnResult.dispatched`.
export type AgentToolResult<TUi = unknown, TKind extends string = string> = {
  content: string;
  events?: TUi[];
  widgets?: AgentToolWidget<TKind>[];
  // Deterministic status lines dropped into the transcript (persisted as
  // `pipeline_status` blocks, stripped from the model's replay).
  statusLines?: string[];
  // Its PRESENCE means failure. Build it with the product's `toolError(…)`,
  // which also bakes the audit marker into `content`.
  error?: ToolError;
};

export interface AgentToolDef<
  TInput,
  TResult extends AgentToolResult<unknown, string>,
> {
  name: string;
  description: string;
  // The tool's one schema: it validates the model's input AND is what the model
  // sees (toolInputSchema derives the JSON schema from it). Field prose goes on
  // each zod node via `.describe(…)`.
  parser: z.ZodType<TInput>;
  handle: (input: TInput, ctx: ToolContext) => Promise<TResult>;
  // Whether completing this tool may have changed what the user is looking at;
  // the client then refetches the panel. Unset counts as `true` (a redundant
  // refetch is cheap, stale data on screen is not) — set `false` only on pure
  // reads and writes nothing on screen shows.
  affectsViewedState?: boolean;
  // When true, a turn that calls this tool ends the agent loop: the caller takes
  // the next step. Set on every routing tool so the stop is automatic.
  handoff?: boolean;
}
