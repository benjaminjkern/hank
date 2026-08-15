// WHO a piece of deterministic work runs for, and how it reports + tears down.
//
// One shape shared by every layer that does multi-step work — procedures
// (`procedures/registry/`), the turn runners (`agent/runtime/`), tool handlers
// (`ToolContext` IS this plus a required sessionId), and sub-agents
// (`subagents/lib/runSubAgent.ts`) — which is why it lives here with the other
// cross-layer vocabularies rather than inside any one of them.
//
// It is a STRUCTURAL contract, and that's load-bearing: a procedure declares its
// args as `RunContext & { … }`, so it passes `args` straight through to whatever
// it calls without rebuilding anything. No ctx-assembling boilerplate at call
// sites, and nothing to keep in sync when a field is added.
//
// Every field here is AMBIENT: it says who/when/where the work runs, and nothing
// in the chain branches on it — the code that reads a field is at the bottom
// (an LLM call, a persisted row, a prompt's # Today block) and everything
// between just forwards it. A value some step in the middle makes a decision
// about is that step's own argument, not ctx.
//
// It is assembled at exactly two boundaries — `runUserMessage` opening a run,
// and `runAgentTurn` dispatching a tool (which adds the parent chip to nest
// under) — and threaded verbatim from there down.

import type { RunTrace } from "@/server/platform/trace/types";

// Re-exported so a caller needing both gets them from one place; the shape
// itself lives with the rest of the trace vocabulary in platform/trace/.
export type { RunTrace };

export type RunContext = {
  userId: string;
  // Optional: some work runs outside a chat session (résumé parsing from the
  // Documents page, the audit harnesses).
  sessionId?: string;
  trace?: RunTrace;
  // Forwarded into every LLM call and outbound fetch so a user Stop (or an
  // orchestrator's own controller) tears the work down. A user abort is
  // RE-THROWN by the sub-agent runner, not swallowed as a failure.
  signal?: AbortSignal;
  // Run-tree capture (admin /admin/runs): one id per runUserMessage call,
  // stamped on every ChatMessage / TokenUsage / SubAgentRun row the run
  // produces so the inspector can group and nest it. Undefined on test paths.
  runId?: string;
  // The browser's IANA timezone for this message (e.g. "America/Los_Angeles").
  // Read at the bottom by Hank's # Today block and the event tools, which use it
  // to interpret a wall-clock time the agent supplies. Undefined (old clients,
  // replay, scripts) falls back to UTC everywhere it's read.
  timeZone?: string;
  // Epoch ms when the chat route's hard cap will abort this run. Read at the
  // bottom by long fan-outs (the scan step) to stand down CLEANLY before the
  // cap rips them mid-flight — a board too big for one run ends with a partial
  // that resumes on re-entry instead of a dead stream. Undefined (scripts,
  // audits, tool dispatch outside a run) means no deadline.
  deadlineAt?: number;
};
