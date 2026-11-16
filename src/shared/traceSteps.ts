// The persisted shape of a trace tree — what the trace accumulator
// (server/platform/runs/traceAccumulator.ts) writes into ChatMessage.traces
// (keyed by tool_use id) and RunTrace.steps (the run root's steps), and what
// /admin/runs and the chat transcript view read back.

export type TraceStep =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      error?: boolean;
      children?: { steps: TraceStep[] };
    }
  // A procedure bracket. Same nesting mechanics as a tool step, deliberately a
  // DIFFERENT kind: the chat renderer flattens spans (the user never sees a
  // procedure masquerading as a tool call) while the run-tree inspector keeps
  // the level.
  | {
      kind: "span";
      id: string;
      name: string;
      // Epoch ms, stamped as the events arrive. `endedAt` is absent on a span
      // the run never closed (it threw past it, or was cut off at the cap).
      startedAt: number;
      endedAt?: number;
      summary?: string;
      error?: boolean;
      children?: { steps: TraceStep[] };
    };

export type TraceMap = Record<string, { steps: TraceStep[] }>;
