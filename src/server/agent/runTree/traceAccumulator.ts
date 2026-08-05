// Accumulate sub-agent TraceEvents into the persisted `ChatMessage.traces` shape
// (admin /admin/runs inspector + the existing session-replay renderer).
//
// The sub-agent runner (runSubAgent.ts) and the vision transforms emit
// trace_text / trace_tool_start / trace_tool_complete events with a
// parentToolUseId chain. runAgentTurn feeds every one of them here and persists
// the snapshot onto the assistant row's `traces` column, which
// `buildAssistantSegments` in src/app/api/session/route.ts renders (recursive
// `{ [parentToolUseId]: { steps } }`, tool steps carry a nested
// `children: { steps }`). Keep this shape in lockstep with `convertTrace` there.
//
// It accumulates UNCONDITIONALLY, not only when a live sink is attached: the
// production chat path has no client-side trace listener, so gating on one
// leaves the column permanently empty.

import type { TraceEvent } from "@/server/platform/trace/types";

type TraceStep =
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
      summary?: string;
      error?: boolean;
      children?: { steps: TraceStep[] };
    };

export type TraceMap = Record<string, { steps: TraceStep[] }>;

type TraceAccumulator = {
  emit: (ev: TraceEvent) => void;
  // The accumulated map, or null when nothing was traced (so the caller can
  // leave the column null rather than write an empty object).
  snapshot: () => TraceMap | null;
};

export function createTraceAccumulator(): TraceAccumulator {
  // Top-level containers keyed by main-agent tool_use id.
  const roots: TraceMap = {};
  // Every nestable step (root-level or nested) by its own id, so a
  // trace_tool_complete / trace_span_complete can find its start and a deeper
  // child can nest under it.
  const stepById = new Map<
    string,
    Extract<TraceStep, { kind: "tool" | "span" }>
  >();

  // The steps container a child with the given parentToolUseId belongs to:
  // if the parent is itself a traced tool step, use/create its `children`;
  // otherwise the parent is a main-agent tool_use id → a root container.
  function containerFor(parentId: string): { steps: TraceStep[] } {
    const parentStep = stepById.get(parentId);
    if (parentStep) {
      if (!parentStep.children) parentStep.children = { steps: [] };
      return parentStep.children;
    }
    if (!roots[parentId]) roots[parentId] = { steps: [] };
    return roots[parentId];
  }

  function emit(ev: TraceEvent): void {
    try {
      if (ev.type === "trace_text") {
        containerFor(ev.parentToolUseId).steps.push({
          kind: "text",
          text: ev.text,
        });
      } else if (ev.type === "trace_tool_start") {
        const step: Extract<TraceStep, { kind: "tool" }> = {
          kind: "tool",
          id: ev.toolUseId,
          name: ev.name,
          input: ev.input,
        };
        containerFor(ev.parentToolUseId).steps.push(step);
        stepById.set(ev.toolUseId, step);
      } else if (ev.type === "trace_tool_complete") {
        const step = stepById.get(ev.toolUseId);
        if (step && step.kind === "tool") {
          step.result = ev.result;
          if (ev.error) step.error = true;
        }
      } else if (ev.type === "trace_span_start") {
        const step: Extract<TraceStep, { kind: "span" }> = {
          kind: "span",
          id: ev.spanId,
          name: ev.name,
        };
        containerFor(ev.parentToolUseId).steps.push(step);
        stepById.set(ev.spanId, step);
      } else if (ev.type === "trace_span_complete") {
        const step = stepById.get(ev.spanId);
        if (step && step.kind === "span") {
          if (ev.summary) step.summary = ev.summary;
          if (ev.error) step.error = true;
        }
      }
    } catch {
      // A trace-capture failure must never break a turn.
    }
  }

  function snapshot(): TraceMap | null {
    return Object.keys(roots).length > 0 ? roots : null;
  }

  return { emit, snapshot };
}
