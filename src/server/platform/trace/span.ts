// Bracket a stretch of work as one named span in the trace tree.
//
// The gap this fills: the run-tree inspector (/admin/runs) nests everything by
// `parentToolUseId`, so it shows turn → tool → sub-agent. The PROCEDURE in the
// middle — the thing that actually decided to run three sub-agents in that order
// — was invisible, and "which step was this sub-agent part of?" had to be
// inferred from the order rows happened to land in.
//
// A span is NOT a tool call and is never rendered as one (docs/tools.md → "Only
// real tools get tool spans"): the chat's trace renderer flattens spans away, so
// the user-visible chip is unchanged. It only adds structure for the inspector.
//
// Two shapes because procedures come in two shapes, and a wrapper can't stay
// lazy around a generator:
//   - `withTraceSpan` for a plain async procedure.
//   - `openTraceSpan` for a generator — open it, thread `span.trace`, close it
//     in a `finally`.
// Both no-op entirely when there's no trace sink or no parent to nest under
// (background jobs, scripts, the audit harnesses).

import { randomUUID } from "node:crypto";

import type { RunTrace } from "./types";

export type TraceSpan = {
  // The trace to hand to everything inside the span — same sink, but children
  // nest under this span instead of the parent chip.
  trace: RunTrace | undefined;
  // Emits the span's close event. Safe to call twice (the second is ignored) so
  // a `finally` can close a span an early return already closed.
  close: (outcome?: { summary?: string; error?: boolean }) => void;
};

export function openTraceSpan(
  name: string,
  trace: RunTrace | undefined,
): TraceSpan {
  const parentToolUseId = trace?.parentToolUseId;
  // Nothing listening, or nothing to nest under — hand back the trace unchanged
  // so callers need no branch of their own.
  if (!trace?.onTrace || !parentToolUseId) {
    return { trace, close: () => {} };
  }

  const spanId = `span_${randomUUID()}`;
  const onTrace = trace.onTrace;
  onTrace({ type: "trace_span_start", spanId, name, parentToolUseId });

  let closed = false;
  return {
    trace: { onTrace, parentToolUseId: spanId },
    close: (outcome) => {
      if (closed) return;
      closed = true;
      onTrace({
        type: "trace_span_complete",
        spanId,
        parentToolUseId,
        ...(outcome?.summary ? { summary: outcome.summary } : {}),
        ...(outcome?.error ? { error: true } : {}),
      });
    },
  };
}

// Run an async procedure inside a span. `fn` receives the span's trace to thread
// into whatever it calls; a throw closes the span as an error and re-throws.
export async function withTraceSpan<T>(
  name: string,
  trace: RunTrace | undefined,
  fn: (spanTrace: RunTrace | undefined) => Promise<T>,
  summarize?: (result: T) => string | undefined,
): Promise<T> {
  const span = openTraceSpan(name, trace);
  try {
    const result = await fn(span.trace);
    span.close({ summary: summarize?.(result) });
    return result;
  } catch (err) {
    span.close({
      summary: err instanceof Error ? err.message : String(err),
      error: true,
    });
    throw err;
  }
}
