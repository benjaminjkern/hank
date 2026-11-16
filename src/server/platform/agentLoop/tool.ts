// The tool contract the agent loop dispatches: a name and description for the
// model, a zod parser (the model-facing JSON schema is derived from it — see
// inputSchema.ts), and a handler.
//
// A result is `content` (what the model reads back) and `error`, plus two
// display channels the loop handles without reading: `events` are relayed to
// the client in order, and `statusLines` are persisted on their own row after
// the turn. Anything else a caller's tools return rides along untouched — the
// loop hands every result back in `dispatched` for the caller to interpret.

import type { RunContext } from "@/server/platform/runs/runContext";

import type { ToolError } from "./toolError";
import type { z } from "zod";

// A tool only runs inside a chat dispatch, so sessionId is always present.
export type ToolContext = RunContext & { sessionId: string };

export type ToolResult<TEvent = unknown> = {
  content: string;
  events?: TEvent[];
  statusLines?: string[];
  // Its PRESENCE means failure. Build via `toolError(code, message, dedupHint)`,
  // which also bakes the audit marker into `content`.
  error?: ToolError;
};

export type ToolDef<TInput, TResult extends ToolResult = ToolResult> = {
  name: string;
  description: string;
  // The tool's one schema: it validates the model's input AND is what the model
  // sees. Field prose goes on each zod node via `.describe(…)`.
  parser: z.ZodType<TInput>;
  handle: (input: TInput, ctx: ToolContext) => Promise<TResult>;
  // Whether completing this tool may have changed what the user is looking at.
  // Unset counts as TRUE: a mutation that forgets the flag still refreshes (a
  // redundant refetch is cheap; stale data on screen is not). Set `false` only
  // for pure reads and writes no screen shows.
  affectsViewedState?: boolean;
  // Hands control to whatever runs after the model: the caller ends its agent
  // loop after a turn that called one, so there's no free post-handoff turn for
  // the model to narrate a screen it didn't draw.
  handoff?: boolean;
};

export type AnyToolDef<TResult extends ToolResult = ToolResult> = ToolDef<
  unknown,
  TResult
>;
