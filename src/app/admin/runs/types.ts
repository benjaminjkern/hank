// Serializable run-tree shapes shared between the server page (assembles from
// ChatMessage / TokenUsage / SubAgentRun) and the client RunTreeView (renders a
// raw collapsible tree). Everything here must be JSON-serializable — no Dates.

import type { TraceStep } from "@/server/agent/runTree/traceAccumulator";

export type { TraceStep };

export type LlmCallInfo = {
  model: string;
  // { maxTokens, thinkingBudget, toolChoice, toolNames, systemPrompt: {hash, volatile} }
  requestParams: unknown;
  // The full system prompt, reconstructed = skeleton (deduped PromptSnapshot) +
  // the per-call volatile pieces. Null when nothing was captured (legacy turns).
  systemPrompt: {
    hash: string | null;
    skeleton: string | null;
    volatile: { key: string; text: string }[];
  } | null;
  usage: {
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    cost: number;
  };
  notes: string | null;
};

export type SubAgentNode = {
  id: string;
  operation: string;
  model: string;
  klass: string;
  ok: boolean;
  outputSchemaName: string | null;
  input: unknown; // { system, initialUserContent }
  output: unknown; // the emitted schema's payload
  error: string | null;
  turns: number | null;
  createdAt: string;
};

export type ToolCallNode = {
  toolUseId: string;
  name: string;
  input: unknown;
  result: string | null;
  isError: boolean;
  // What ran inside this tool call: procedure spans, read tools, trace text.
  // Empty when nothing was traced.
  steps: TraceStep[];
  // Sub-agent runs anywhere in this call's tree (the badge count).
  subAgentCount: number;
};

// One item in the run's ordered timeline.
export type RunItem =
  | { kind: "user"; id: string; createdAt: string; text: string; raw: unknown }
  | {
      kind: "turn";
      id: string; // assistant ChatMessage id (== messageId)
      createdAt: string;
      turnIndex: number | null;
      stoppedByUser: boolean;
      llm: LlmCallInfo | null;
      // Raw assistant content blocks (thinking / text / tool_use).
      content: unknown[];
      toolCalls: ToolCallNode[];
    }
  | { kind: "status"; id: string; createdAt: string; text: string }
  // The run threw. Persisted as a `run_error` block by runUserMessage, and the
  // last item in its run by construction — everything after the throw is work
  // that never happened.
  | { kind: "error"; id: string; createdAt: string; detail: string }
  | {
      kind: "widget";
      id: string;
      createdAt: string;
      widgetKind: string;
      payload: unknown;
    };

export type RunTree = {
  runId: string; // the real runId, or "legacy:<sessionId>" for pre-capture data
  legacy: boolean;
  sessionId: string;
  userEmail: string | null;
  userId: string | null;
  createdAt: string;
  cost: number;
  turnCount: number;
  items: RunItem[];
  // The procedure spans the run opened outside any tool call (its RunTrace row),
  // nested under the run root. Empty for runs captured before the root existed.
  rootSteps: TraceStep[];
  // Every sub-agent run, keyed by the trace node it ran under: a span id, a
  // tool_use id, or the runId (the run root). The tree hangs each one there.
  subAgentsByTraceParent: Record<string, SubAgentNode[]>;
  // Sub-agent runs whose node isn't in any loaded tree (legacy runs, or a
  // trace that failed to save) — listed at run level so nothing goes missing.
  unplacedSubAgents: SubAgentNode[];
};

export type RunSummary = {
  runId: string;
  legacy: boolean;
  sessionId: string;
  userEmail: string | null;
  userId: string | null;
  createdAt: string; // latest activity in the run
  turnCount: number;
  cost: number;
  stopped: boolean;
  flow: string | null; // parsed from TokenUsage notes (pipeline=X)
};

export type RunsIndexData = {
  runs: RunSummary[];
  filter: {
    user: string | null;
    session: string | null;
    run: string | null;
  };
  page: number; // 1-indexed
  pageSize: number;
  hasNext: boolean;
};
