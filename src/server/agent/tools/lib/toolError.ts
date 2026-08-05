// Standard tool-error shape: every tool failure is a machine-readable
// `{ code, message, dedupHint? }`, so aggregation (the session-audit,
// error-rate dashboards) never has to regex over prose.
//
// Two transports for the same information:
//   1. The structured `error` object rides on the in-process `ToolResult.error`.
//      In-process consumers (the agent-turn
//      serializers) read it directly.
//   2. For durability it is ALSO encoded as an inert `<!--tool-error:{...}-->`
//      marker appended to `content`, mirroring the `<!--n:{...}-->`
//      widget-response marker pattern (see WidgetResponseCard.tsx). The marker
//      is what survives into the persisted tool_result ChatMessage, so
//      session-audit / dashboards parse one stable token instead of the prose.
//
// Why the marker is safe to embed in `content`: every surface that renders tool
// content is markdown-rendered (chat text, the expandable tool chip), and
// markdown hides HTML comments — so the marker is invisible to the user. The
// `message` stays the human-readable, LLM-facing text (what was tried / why it
// was blocked / what to do — see docs/tools.md), unchanged from before.

import type { ToolResult } from "./types";

// Broad bucket codes. The specific "why" lives in `dedupHint`, which is what the
// session-audit keys off — so a debatable code is never load-bearing.
export type ToolErrorCode =
  // An id or name didn't resolve to a row (jobId / companyId / contactId /
  // opportunityId / attachmentId / JobInteraction, or "no X matching <name>").
  | "ENTITY_NOT_FOUND"
  // Schema / parse failure, bad enum value, malformed date, or a structurally
  // required field that was absent (e.g. closeReason missing when status=CLOSED).
  | "INVALID_INPUT"
  // The input was well-formed but couldn't be resolved to a target from context
  // (no id or slug passed; "could not resolve a companyId").
  | "AMBIGUOUS_INPUT"
  // A business invariant intentionally blocked the operation (CAUGHT_UP with
  // open jobs, the shortlist-round gate, company CLOSED / not on the watchlist,
  // …). The op did not happen, by design.
  | "GATE_BLOCKED"
  // A contradictory request: a field paired with the wrong status (closeReason
  // with status≠CLOSED, deferReason with status≠DEFERRED, …).
  | "STATE_CONFLICT"
  // A child sub-agent errored, hit max_tokens, or returned no structured output.
  | "SUB_AGENT_FAILED"
  // An external fetch / scrape returned non-200 or threw.
  | "UPSTREAM_FETCH_FAILED"
  // A provider returned 429 / rate-limited the request.
  | "RATE_LIMITED"
  // Unknown tool, or an unhandled exception caught at the dispatch boundary.
  | "DISPATCH_ERROR";

export type ToolError = {
  code: ToolErrorCode;
  // Human-readable, LLM-facing. Keep the docs/tools.md convention: name what was
  // tried, why it was blocked, and what to do next.
  message: string;
  // `<source>:<failure mode>:<input shape>` — same convention as AdminNote
  // dedupKeys (see AGENTS.md "Admin observation gotchas"). e.g.
  // `caught_up_company:gate:open_jobs`. The audit/dedup layer keys off this, so
  // pick it deliberately and grep for collisions.
  dedupHint?: string;
};

const MARKER_PREFIX = "<!--tool-error:";
const MARKER_SUFFIX = "-->";

// The inert audit marker. Carries only the machine-readable bits (code +
// dedupHint); the message already lives in `content` ahead of the marker.
function toolErrorMarker(err: Pick<ToolError, "code" | "dedupHint">): string {
  const payload: { code: ToolErrorCode; dedupHint?: string } = {
    code: err.code,
  };
  if (err.dedupHint) payload.dedupHint = err.dedupHint;
  return `${MARKER_PREFIX}${JSON.stringify(payload)}${MARKER_SUFFIX}`;
}

// `content` string with the audit marker appended on its own line. Used by the
// dispatch sites and streaming-tool bodies that assemble content inline rather
// than returning a `ToolResult`.
export function toolErrorContent(
  code: ToolErrorCode,
  message: string,
  dedupHint?: string,
): string {
  return `${message}\n${toolErrorMarker({ code, dedupHint })}`;
}

// The canonical error result. Tool handlers `return toolError(code, msg, hint)`.
// Rare errors that also need to emit events/widgets can spread:
// `{ ...toolError(...), events }`.
export function toolError(
  code: ToolErrorCode,
  message: string,
  dedupHint: string,
): ToolResult {
  return {
    content: toolErrorContent(code, message, dedupHint),
    error: { code, message, ...(dedupHint ? { dedupHint } : {}) },
  };
}

const PARSE_RE = /<!--tool-error:(\{[\s\S]*?\})-->/;
const STRIP_RE = /\n?<!--tool-error:\{[\s\S]*?\}-->/g;

// Recover the structured code/dedupHint from a persisted tool_result's content.
// For session-audit / error-rate dashboards. Returns null when no marker present.
export function parseToolErrorMarker(
  content: string,
): { code: ToolErrorCode; dedupHint?: string } | null {
  const m = PARSE_RE.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as { code: ToolErrorCode; dedupHint?: string };
  } catch {
    return null;
  }
}

// Drop the marker for human display. The live tool-result chip renders raw text
// (not markdown), so the inert comment would otherwise be visible there. The
// persisted / LLM / audit copies keep the marker.
export function stripToolErrorMarker(content: string): string {
  return content.replace(STRIP_RE, "");
}
