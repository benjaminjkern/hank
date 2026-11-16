// The inert `<!--tool-error:{...}-->` marker a failed tool result carries in its
// `content`. Shared because three readers need it on different sides: the
// server writes it (platform/agentLoop/toolError.ts), the chat panel strips it for
// display, and the session-audit harness parses it back out.

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

const MARKER_PREFIX = "<!--tool-error:";
const MARKER_SUFFIX = "-->";

// The inert audit marker. Carries only the machine-readable bits (code +
// dedupHint); the message already lives in `content` ahead of the marker.
export function toolErrorMarker(err: {
  code: ToolErrorCode;
  dedupHint?: string;
}): string {
  const payload: { code: ToolErrorCode; dedupHint?: string } = {
    code: err.code,
  };
  if (err.dedupHint) payload.dedupHint = err.dedupHint;
  return `${MARKER_PREFIX}${JSON.stringify(payload)}${MARKER_SUFFIX}`;
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
