// Every model the app can run, and which provider serves it. This is a fact
// table about models — not a policy about which call uses which. That choice is
// declared by each call site (a sub-agent's own `MODEL` const, HANK_MODEL for
// the main agent) and is never remapped: the model a call site names is the
// model that runs.
//
// Consequences worth knowing:
//   - `LlmModel` is a closed union, so a typo'd id is a TYPE error, not a
//     request that quietly goes to the wrong endpoint with the wrong key.
//   - Adding a model means adding a row here. That's the point — an id with no
//     provider is unroutable.
//
// DeepSeek serves its models through an *Anthropic-compatible* Messages
// endpoint, so the same `@anthropic-ai/sdk` client talks to both (see
// deepseek.ts). It rejects image/document content blocks, which is why the two
// vision sub-agents name a Claude model.

export type LlmProvider = "anthropic" | "deepseek";

export const MODELS = {
  // The product tiers. pro is the capable one; flash is ~3x cheaper.
  "deepseek-v4-pro": "deepseek",
  "deepseek-v4-flash": "deepseek",
  // Vision only — resume parsing and logo verification send content blocks
  // DeepSeek's endpoint can't accept.
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5": "anthropic",
} as const satisfies Record<string, LlmProvider>;

export type LlmModel = keyof typeof MODELS;
