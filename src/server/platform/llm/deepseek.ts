import Anthropic from "@anthropic-ai/sdk";

// Everything specific to talking to DeepSeek — the base URL and the request
// normalization its endpoint needs. Which models it serves is in models.ts; key
// resolution is in resolveClient.ts.
//
// Why the Anthropic SDK talks to DeepSeek at all: DeepSeek exposes an
// *Anthropic-compatible* endpoint that speaks the Messages dialect, so the same
// client works with only `baseURL` + key + model swapped. Verified against
// https://api-docs.deepseek.com/guides/anthropic_api (2026-06-18):
//   - text + thinking blocks: supported
//   - server_tool_use + web_search_tool_result (web search): supported
//   - image + document content blocks: NOT supported → resume-parse and
//     logo-verify name a Claude model for exactly this reason.
//   - cache_control: silently ignored (DeepSeek auto-caches by prefix). Our
//     sub-agent cache markers therefore no-op — harmless, but see the
//     usage-tracking note in src/server/platform/usage/pricing.ts.

export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

export function createDeepseekClient(apiKey: string): Anthropic {
  return withRequestDefaults(
    new Anthropic({ apiKey, baseURL: DEEPSEEK_ANTHROPIC_BASE_URL }),
  );
}

// DeepSeek v4-pro defaults to THINKING mode, and thinking mode rejects a forced
// `tool_choice` ("Thinking mode does not support this tool_choice", HTTP 400).
// Sub-agents force tool_choice (every transform forces its one output schema;
// runSubAgent forces its schema on the last turn), so for THOSE calls thinking
// must be off. We therefore DEFAULT thinking to disabled — but only when the
// call site hasn't already set it. The MAIN agent stream (runAgentTurn) sets
// `thinking: {type:"enabled", budget_tokens}` with NO forced tool_choice, so it
// opts in and we preserve that. This both gives the chat surface
// real reasoning and fixes the DeepSeek reasoning-leak (a reasoning model with
// thinking force-disabled dumped its reasoning into the visible text).
//
// Monkey-patching `messages` is deliberate: the SDK has no request-body hook,
// and every call site already goes through the client this factory returns, so
// patching here fixes them all at one point.
function withRequestDefaults(client: Anthropic): Anthropic {
  const messages = client.messages as unknown as {
    create: (body: Record<string, unknown>, options?: unknown) => unknown;
    stream: (body: Record<string, unknown>, options?: unknown) => unknown;
  };
  const create = messages.create.bind(messages);
  const stream = messages.stream.bind(messages);

  const applyDefaults = (body: Record<string, unknown>) => {
    const out: Record<string, unknown> = {
      ...body,
      // Forced-schema sub-agents leave it unset → disabled; the main agent sets
      // enabled → kept.
      thinking: body.thinking ?? { type: "disabled" as const },
    };
    // v4-pro (non-thinking) emits larger tool payloads than Claude and truncates
    // against caps sized for Claude — observed: shortlist-jobs + application
    // drafting hit max_tokens mid-tool-call and returned nothing. Double the cap
    // (billed per ACTUAL output token, so a higher cap only costs more when the
    // model genuinely needs the room), bounded by v4-pro's 384k output ceiling.
    if (typeof out.max_tokens === "number") {
      out.max_tokens = Math.min(out.max_tokens * 2, 384_000);
    }
    return out;
  };

  messages.create = (body, options) => create(applyDefaults(body), options);
  messages.stream = (body, options) => stream(applyDefaults(body), options);
  return client;
}
