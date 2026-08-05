// Shared streaming primitives used by the turn runners: the HIDDEN_TOOLS set and
// the pure helpers (isTransientStreamError, emptyAbortedMessage,
// applyHistoryCacheMarker). See docs/runtime.md for the architecture they
// support.
//
// Nothing here knows what a company or a job is — that's the bar for everything
// under runtime/.

import type Anthropic from "@anthropic-ai/sdk";

// Tools whose invocation should not appear in the chat UI. They still run
// and their tool_use/tool_result blocks are still persisted so the model's
// next-turn replay sees them — we just don't stream chips to the client.
// The set + its companion in src/app/api/session/route.ts remain in place as
// the affordance for a future tool that genuinely warrants suppression
// (admin-only telemetry, etc.) — don't delete the mechanism, just the
// entries when they're no longer wanted.
export const HIDDEN_TOOLS = new Set<string>();

// Transient connection failures on the streaming HTTP response — the socket
// drops mid-generation. undici surfaces these as `TypeError: terminated`
// (often with a socket-code `.cause`); the SDK wraps connect-time drops as
// APIConnectionError / APIConnectionTimeoutError. These are not user aborts and
// not application bugs — they're network flakes. The caller degrades to the
// partial message (same as the abort path) instead of crashing the turn with a
// raw error, so the user keeps whatever streamed and can just continue.
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === "APIConnectionError" || ctor === "APIConnectionTimeoutError") {
    return true;
  }
  const msg = err.message?.toLowerCase() ?? "";
  if (
    msg.includes("terminated") ||
    msg.includes("socket hang up") ||
    msg.includes("other side closed") ||
    msg.includes("premature close")
  ) {
    return true;
  }
  const code =
    (err as { code?: string }).code ??
    (err as { cause?: { code?: string } }).cause?.code;
  return code != null && TRANSIENT_SOCKET_CODES.has(code);
}

// Minimal stand-in for cases where stream.currentMessage is undefined because
// the abort fired before the first content block landed. Cast through
// `unknown` rather than mirroring every Anthropic.Message field (container,
// stop_details, etc.) so SDK additions don't break us — the consumers we
// care about (content, usage, stop_reason) are all populated.
export function emptyAbortedMessage(model: string): unknown {
  return {
    id: "",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// NOTE: "should the loop stop and wait for the user?" is deliberately NOT
// derivable here. It's `endsAwaitingUser` from loadSessionMessages, computed off
// the RAW rows, because provenance re-roling moves a wait-for-user terminal (a
// pipeline_widget / status line) onto the `role:"system"` channel — so the
// re-roled history's last role can't answer it.

// Mark a cache breakpoint at the end of the message history so subsequent
// turns read most of the conversation from cache (10% cost) instead of full
// input tokens. The cache TTL is 5 minutes — within a single walkthrough
// this saves a lot.
export function applyHistoryCacheMarker(
  history: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (history.length === 0) return history;
  const last = history[history.length - 1];
  if (typeof last.content === "string") {
    return [
      ...history.slice(0, -1),
      {
        role: last.role,
        content: [
          {
            type: "text",
            text: last.content,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ];
  }
  if (!Array.isArray(last.content) || last.content.length === 0) return history;
  const blocks = [...last.content];
  const i = blocks.length - 1;
  const target = blocks[i];
  if (target && typeof target === "object") {
    blocks[i] = {
      ...target,
      cache_control: { type: "ephemeral" },
    } as Anthropic.ContentBlockParam;
  }
  return [...history.slice(0, -1), { role: last.role, content: blocks }];
}
