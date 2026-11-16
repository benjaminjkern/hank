// The one way to declare a procedure entry point. Every `run<Name>` export in
// procedures/registry/ is built by `procedure`, and the span for an entry is
// opened here and nowhere else — so every procedure is traced the same
// way, and none can forget to be. (A STEP inside one procedure may still bracket
// itself with platform/runs/span.ts — the drafting loop does.)
//
// The shape is fixed: ONE argument, an object that extends RunContext (the
// procedure's own inputs plus the ambient userId / sessionId / trace / signal),
// passed straight through by callers (`runScan({ ...args, companyId })`). A
// procedure that talks to the user while it runs takes `say` among those args
// and awaits it (contracts/events.ts → Say); its result is still just what it
// returns.
//
// The span nests under `args.trace` and the procedure body receives the span's
// trace, so anything it calls (sub-agents, other procedures) nests under it in
// /admin/runs. With no trace parent (a run the chat loop drives itself, scripts)
// the span is a no-op — see platform/runs/span.ts.

import type { RunContext } from "@/server/platform/runContext";
import { openTraceSpan } from "@/server/platform/runs/span";

type ProcedureOptions<R> = {
  // One line for the span's close event in the inspector.
  summarize?: (result: R) => string | undefined;
};

function errorSummary(err: unknown) {
  return {
    summary: err instanceof Error ? err.message : String(err),
    error: true,
  };
}

export function procedure<A extends RunContext, R>(
  name: string,
  run: (args: A) => Promise<R>,
  options: ProcedureOptions<R> = {},
): (args: A) => Promise<R> {
  return async (args) => {
    const span = openTraceSpan(name, args.trace);
    try {
      const result = await run({ ...args, trace: span.trace });
      span.close({ summary: options.summarize?.(result) });
      return result;
    } catch (err) {
      span.close(errorSummary(err));
      throw err;
    }
  };
}
