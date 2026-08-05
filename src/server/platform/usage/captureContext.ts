// Run-tree capture context (admin /admin/runs inspector).
//
// The problem: a sub-agent's `recordSubAgentRun` and its per-turn `recordUsage`
// fire deep inside a tool handler, many call-sites removed from the main-agent
// turn that spawned them. Threading runId / parent-message / parent-tool through
// every sub-agent registry + procedure signature would touch dozens of files.
//
// Instead we stash the capture context in an AsyncLocalStorage set ONCE, at the
// main loop's tool-dispatch boundary (agentRunner wraps each `tool.handle()` in
// `withCaptureContext`). Because ALS propagates across every await inside that
// handler — including nested sub-agent LLM calls — `recordUsage` and
// `recordSubAgentRun` can read the current context with zero call-site plumbing.
//
// NOTE: only wrap NON-generator async boundaries (a plain `tool.handle()` call).
// Wrapping a generator body is unreliable — its continuation runs in the
// consumer's async context, not the one `storage.run` established. The main
// agent turns are all covered because tool dispatch is a regular async call.

import { AsyncLocalStorage } from "node:async_hooks";

type CaptureContext = {
  // The runUserMessage invocation this work belongs to. Groups every ChatMessage
  // / TokenUsage / SubAgentRun row of one run.
  runId?: string;
  // The assistant ChatMessage id of the main-agent turn currently dispatching a
  // tool. Sub-agent rows record it as their parentMessageId.
  messageId?: string;
  // The main-agent tool_use id currently dispatching. Sub-agent rows record it as
  // their parentToolUseId so the viewer nests them under the exact tool node.
  parentToolUseId?: string;
};

const storage = new AsyncLocalStorage<CaptureContext>();

// Run `fn` with the capture context active. Nested calls merge over the parent
// context so agentRunner can layer messageId/parentToolUseId onto an outer runId.
export function withCaptureContext<T>(
  ctx: CaptureContext,
  fn: () => Promise<T>,
): Promise<T> {
  const merged = { ...(storage.getStore() ?? {}), ...ctx };
  return storage.run(merged, fn);
}

// The capture context in effect for the current async execution, or an empty
// object outside any run (background jobs, scripts, deterministic widget paths).
export function currentCaptureContext(): CaptureContext {
  return storage.getStore() ?? {};
}
