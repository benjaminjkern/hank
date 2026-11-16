// The one way to declare a procedure entry point. Every `run<Name>` export in
// procedures/registry/ is built by `procedure` (async) or `streamingProcedure`
// (an async generator that yields chat events as it goes), and the span for an
// entry is opened here and nowhere else — so every procedure is traced the same
// way, and none can forget to be. (A STEP inside one procedure may still bracket
// itself with platform/trace/span.ts — the drafting loop does.)
//
// The shape is fixed: ONE argument, an object that extends RunContext (the
// procedure's own inputs plus the ambient userId / sessionId / trace / signal),
// passed straight through by callers (`runScan({ ...args, companyId })`).
//
// The span nests under `args.trace` and the procedure body receives the span's
// trace, so anything it calls (sub-agents, other procedures) nests under it in
// /admin/runs. With no trace parent (a run the chat loop drives itself, scripts)
// the span is a no-op — see platform/trace/span.ts.

import type { RunContext } from "@/server/agent/contracts";
import { openTraceSpan } from "@/server/platform/trace/span";

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

export function streamingProcedure<A extends RunContext, E, R = void>(
  name: string,
  run: (args: A) => AsyncGenerator<E, R>,
  options: ProcedureOptions<R> = {},
): (args: A) => AsyncGenerator<E, R> {
  return async function* (args) {
    const span = openTraceSpan(name, args.trace);
    try {
      const result = yield* run({ ...args, trace: span.trace });
      span.close({ summary: options.summarize?.(result) });
      return result;
    } catch (err) {
      span.close(errorSummary(err));
      throw err;
    } finally {
      // A consumer that stops iterating early (`return()` on the generator)
      // skips both branches above; close() is idempotent.
      span.close();
    }
  };
}
