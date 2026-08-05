// Serializable run-tree shapes shared between the server page (assembles from
// ChatMessage / TokenUsage / SubAgentRun) and the client RunTreeView (renders a
// raw collapsible tree). Everything here must be JSON-serializable — no Dates.

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
  // Sub-agent interior trace (raw { steps } for this tool_use), or null.
  trace: unknown | null;
  // Sub-agent runs whose parentToolUseId is this tool_use.
  subAgents: SubAgentNode[];
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
  // Sub-agent runs with no parent tool_use (deterministic-path sub-agents, e.g.
  // the state machine's drafting/shortlist) — attached at run level.
  orphanSubAgents: SubAgentNode[];
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
