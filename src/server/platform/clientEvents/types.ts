// Shared shape for browser-reported client events. Imported by both
// the POST /api/client-events route (server) and the reportClientEvent helper
// (client) — it's pure types + small pure functions, no server-only deps, so
// it bundles fine into the client (same precedent as importing tool types into
// components).

import { z } from "zod";

import { stringField } from "@/utils/guards";

export const CLIENT_EVENT_SOURCES = [
  "sse_disconnect", // SSE chat stream dropped mid-turn (no terminal event seen)
  "chat_error", // chat route returned an error event / the POST failed (non-modal)
  "modal", // ApiKeyBlocker modal shown (context.reason = missing|invalid|no_credit|missing_deepseek)
  "render_error", // a React error boundary caught a render crash
  "stop", // user clicked Stop (context.reason = soft|hard)
  "widget_failure", // a chat widget failed to validate / render
] as const;
export type ClientEventSource = (typeof CLIENT_EVENT_SOURCES)[number];

export const CLIENT_EVENT_SEVERITIES = ["info", "warn", "error"] as const;
export type ClientEventSeverity = (typeof CLIENT_EVENT_SEVERITIES)[number];

// Wire shape the browser POSTs to /api/client-events. Note there's no
// sessionId / messageId: the route resolves the caller's active session
// server-side (the client's streaming message ids are local temp UUIDs, not DB
// row ids, so they can't be trusted as FKs).
export const ClientEventInputSchema = z.object({
  source: z.enum(CLIENT_EVENT_SOURCES),
  severity: z.enum(CLIENT_EVENT_SEVERITIES).default("warn"),
  // User-facing one-liner describing what the user saw. Surfaced verbatim in
  // the turn-start <recent-client-errors> block, so keep it plain-language.
  summary: z.string().min(1).max(500),
  // Structured detail bag; shape varies by source. Stored as JSON, used to
  // derive the dedupKey.
  context: z.unknown().nullish(),
});
export type ClientEventInput = z.infer<typeof ClientEventInputSchema>;

// `<source>:<failure mode>:<input shape>` — same convention as AdminNote
// dedupKeys (AGENTS.md "Admin observation gotchas"). Derived server-side from
// source + context so the convention stays centralized; the client never sends
// a dedupKey. Nothing reads it at runtime today — it's stamped on each row as a
// grouping key for a future client-event audit/analytics ingest (see
// ClientEvent.dedupKey in schema.prisma).
export function deriveClientEventDedupKey(
  source: ClientEventSource,
  context: Record<string, unknown> | null | undefined,
): string {
  switch (source) {
    case "sse_disconnect":
      return `client:sse_disconnect:${stringField(context, "toolName", "stream")}`;
    case "chat_error":
      return `client:chat_error:${stringField(context, "code", "generic")}`;
    case "modal":
      return `client:modal:${stringField(context, "reason", "unknown")}`;
    case "render_error":
      return `client:render_error:${stringField(context, "component", "unknown")}`;
    case "widget_failure":
      return `client:widget_failure:${stringField(context, "widgetKind", "unknown")}`;
    case "stop":
      return `client:stop:${stringField(context, "reason", "user")}`;
    default:
      return `client:${source as string}`;
  }
}
