// The root of one chat run's trace (/admin/runs). `trace` is handed to the run
// as its RunContext.trace, so every procedure span opened outside a tool call
// has a parent — the run itself, whose node id IS the runId. `save` persists
// that subtree as the run's RunTrace row when the run ends.
//
// Tool calls keep their own trees on ChatMessage.traces. Their events still pass
// through this sink (runAgentTurn forwards to the outer trace), but they nest
// under tool ids, not the run root, so `save` never writes them twice.

import { prisma } from "@/server/db/prisma";
import type { Prisma } from "@/server/generated/prisma/client";
import type { RunTrace } from "@/server/platform/trace/types";

import { createTraceAccumulator } from "./traceAccumulator";

export function openRunTrace(scope: {
  runId: string;
  userId: string;
  sessionId: string;
}): { trace: RunTrace; save: () => Promise<void> } {
  const acc = createTraceAccumulator();
  return {
    trace: { onTrace: acc.emit, parentToolUseId: scope.runId },
    // Best-effort, and safe to call from a `finally`: losing the inspector's
    // view of a run must never fail the run, so the write swallows its errors.
    save: async () => {
      const steps = acc.snapshot()?.[scope.runId]?.steps;
      if (!steps?.length) return;
      try {
        await prisma.runTrace.create({
          data: {
            runId: scope.runId,
            userId: scope.userId,
            sessionId: scope.sessionId,
            // TraceStep's `input` is unknown, so it isn't typed as JSON — it is
            // the tool input the model sent, which always is.
            steps: steps as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.warn("[runTrace] save failed:", err);
      }
    },
  };
}
