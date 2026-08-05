// The sub-agent trace vocabulary. Lives in platform/ rather than agent/tools/lib/
// because it is pure observability plumbing — it names spans and their nesting,
// and knows nothing about companies, jobs, or opportunities. Producers span the
// whole codebase (tool handlers, the sub-agent runner, scrape/), so a home under
// agent/tools/ forced scrape/ to import upward into the agent layer for a type it
// only forwards.

// Sub-agent trace events. Tool handlers that internally run a sub-agent
// (judgement: the read-tool loop; transform: a single call) push
// these into the main loop so the chat UI can render a nested, expandable
// thought-process tree under the parent tool chip. `parentToolUseId` is the
// id of the main-agent tool currently dispatching — children render inside
// that chip's expanded panel. Nested children chain via their own toolUseId
// becoming a parent for further-nested events (recursive).
export type TraceEvent =
  | {
      type: "trace_text";
      text: string;
      parentToolUseId: string;
    }
  // A named bracket around a stretch of work — one PROCEDURE running. Not a tool
  // call and never rendered as one: the chat flattens spans away (the user sees
  // the same chip contents as before), while the run-tree inspector keeps the
  // nesting, which is the whole point — it's what makes the procedure layer
  // between a tool and its sub-agents visible instead of implied. Children nest
  // by naming `spanId` as their `parentToolUseId`, the same chaining tool spans
  // already use.
  | {
      type: "trace_span_start";
      spanId: string;
      name: string;
      parentToolUseId: string;
    }
  | {
      type: "trace_span_complete";
      spanId: string;
      // One-line outcome for the inspector ("12 jobs scanned, 3 closed"), or a
      // failure message. Optional — a span is useful for its shape alone.
      summary?: string;
      error?: boolean;
      parentToolUseId: string;
    }
  | {
      type: "trace_tool_start";
      toolUseId: string;
      name: string;
      input: unknown;
      parentToolUseId: string;
    }
  | {
      type: "trace_tool_complete";
      toolUseId: string;
      result: string;
      error?: boolean;
      parentToolUseId: string;
      // Optional tool name. The judgement sub-agent runner (subAgent.ts) sets
      // this so the chat loop can look up `affectsViewedState` for the tool
      // and propagate the same mid-turn-refresh signal that root tools get.
      // Transform sub-agents (parse / compact / logoVerifier) use synthetic
      // span names that aren't in the main tool registry and can leave this
      // undefined — those flows don't mutate viewed state anyway.
      name?: string;
    };

export type EmitTrace = (event: TraceEvent) => void;

// Where in-flight activity is reported: the sink, plus which parent chip/span it
// nests under. Both optional — outside a chat dispatch there's nothing
// listening, so every emitter no-ops rather than branching. Carried by
// `RunContext` (agent/contracts/runContext.ts); it lives here because it's pure
// observability plumbing, like `EmitTrace` itself.
export type RunTrace = {
  onTrace?: EmitTrace;
  parentToolUseId?: string;
};
