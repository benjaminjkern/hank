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

import { toolErrorMarker, type ToolErrorCode } from "@/shared/toolErrorMarker";

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
// `{ ...toolError(...), events }`. Typed as just the two fields so it fits any
// product's result type.
export function toolError(
  code: ToolErrorCode,
  message: string,
  dedupHint: string,
): { content: string; error: ToolError } {
  return {
    content: toolErrorContent(code, message, dedupHint),
    error: { code, message, ...(dedupHint ? { dedupHint } : {}) },
  };
}
