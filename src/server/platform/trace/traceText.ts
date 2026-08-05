// Emit one prose line into the trace tree, under whatever chip or span the
// caller's `RunTrace` points at.
//
// The counterpart to `openTraceSpan`/`withTraceSpan` (span.ts) and it follows
// the same rule: no sink or no parent to nest under → no-op, so a caller never
// writes the guard itself. That guard is the whole reason this is shared —
// spelled out per call site it's four lines of ceremony around one field, and a
// site that forgets half of it either crashes or invents a parent id that nests
// nowhere.

import type { RunTrace } from "./types";

export function traceText(trace: RunTrace | undefined, text: string): void {
  if (!trace?.onTrace || !trace.parentToolUseId) return;
  trace.onTrace({
    type: "trace_text",
    text,
    parentToolUseId: trace.parentToolUseId,
  });
}
