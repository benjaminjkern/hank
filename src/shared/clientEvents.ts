// The vocabulary of browser-reported client events: what the reporter
// (client/clientEvents.ts) may send, and what the POST /api/client-events
// route's schema (server/platform/clientEvents/types.ts) accepts.

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
