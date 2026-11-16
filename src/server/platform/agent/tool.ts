// The tool contract the agent loop (runAgentTurn) dispatches against — generic
// over what it carries without reading: the panel events a tool shows (`TUi`),
// what a handoff tool queues (`TNext`), and whatever extra outcome fields the
// product puts on a result. The product's own tool types narrow this in
// src/server/tools/lib/types.ts; this file names no product concept.

import type { RunContext } from "@/server/platform/runContext";

import type { ToolError } from "./toolError";
import type { z } from "zod";

// What a tool may say while it runs: move the panel, or add a status line to the
// chat. Never text (that's the model's) and never a widget — asking the user is a
// procedure's job, which a handoff tool queues. The loop shows what was said
// once the tool's chip completes, in the order it was said.
export type ToolSaid<TUi> =
  { type: "ui"; event: TUi } | { type: "pipeline_status"; text: string };

// A tool handler's context IS the ambient RunContext — a tool dispatch is just
// one more place work runs for a user — plus the two hooks a tool talks back
// through. `runAgentTurn` assembles it once per dispatch, setting
// `trace.parentToolUseId` to this tool's own tool_use_id so anything it spawns
// nests under its chip. A handler forwards it verbatim (`{ ...ctx, companyId }`)
// into whatever it calls.
//
// `sessionId` is required here and optional on RunContext: a tool only ever runs
// inside a chat dispatch.
export type ToolContext<TUi = unknown, TNext = unknown> = RunContext & {
  sessionId: string;
  say: (event: ToolSaid<TUi>) => Promise<void>;
  // Queue what runs once the agent's turn is over. Only a `handoff` tool may call
  // it, and only once per turn across every tool in it — a second call throws
  // HandoffConflictError. Dropped if the tool then returns an error, so a
  // handoff that failed hands nothing off and the agent keeps going.
  queue: (next: TNext) => void;
};

// What the loop reads off a result: `content` (and `error`) for the model.
// Anything else a product adds rides along untouched and comes back in
// `AgentTurnResult.dispatched`.
export type AgentToolResult = {
  content: string;
  // Its PRESENCE means failure. Build it with the product's `toolError(…)`,
  // which also bakes the audit marker into `content`.
  error?: ToolError;
};

// A second hand-off in one turn. Thrown by `ctx.queue`; the loop turns it into a
// tool error the agent reads, naming what's already queued.
export class HandoffConflictError extends Error {}

export interface AgentToolDef<
  TInput,
  TResult extends AgentToolResult,
  TUi = unknown,
  TNext = unknown,
> {
  name: string;
  description: string;
  // The tool's one schema: it validates the model's input AND is what the model
  // sees (toolInputSchema derives the JSON schema from it). Field prose goes on
  // each zod node via `.describe(…)`.
  parser: z.ZodType<TInput>;
  handle: (input: TInput, ctx: ToolContext<TUi, TNext>) => Promise<TResult>;
  // Whether completing this tool may have changed what the user is looking at;
  // the client then refetches the panel. Unset counts as `true` (a redundant
  // refetch is cheap, stale data on screen is not) — set `false` only on pure
  // reads and writes nothing on screen shows.
  affectsViewedState?: boolean;
  // This tool hands off: it may call `ctx.queue`. A turn in which something was
  // queued ends the agent loop, and the caller runs what was queued. A handoff
  // tool that fails queues nothing, so the agent reads the error and continues.
  handoff?: boolean;
}
