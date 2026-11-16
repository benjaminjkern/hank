// Client-side reporter for browser events the server/agent would otherwise
// never see: SSE disconnects, ApiKeyBlocker triggers, right-panel
// render crashes, Stop clicks, widget render failures.
//
// Fire-and-forget: never throws, never blocks the caller, never surfaces to the
// user. The route resolves the caller's session + userId server-side, so the
// payload is just what happened. `keepalive` lets the report survive an unload
// or a crash that unmounts the tree.

import type {
  ClientEventSource,
  ClientEventSeverity,
} from "@/server/platform/clientEvents/types";

type ReportClientEventArgs = {
  source: ClientEventSource;
  severity?: ClientEventSeverity;
  // Plain-language, user-safe one-liner — surfaced verbatim to the agent in the
  // turn-start <recent-client-errors> block.
  summary: string;
  // Structured detail; keys are read server-side to derive the dedupKey
  // (toolName / reason / component / widgetKind / code).
  context?: Record<string, unknown>;
};

export function reportClientEvent(args: ReportClientEventArgs): void {
  try {
    void fetch("/api/client-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: args.source,
        severity: args.severity ?? "warn",
        summary: args.summary,
        context: args.context ?? null,
      }),
      keepalive: true,
    }).catch(() => {
      // swallow — telemetry must never affect the session
    });
  } catch {
    // swallow
  }
}
