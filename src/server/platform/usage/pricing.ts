// Anthropic pricing as of 2026-05; DeepSeek as of 2026-06-18. Token rates are
// $/M; web search is $/1k. Match by substring on the model id stored on each
// TokenUsage row so future `claude-sonnet-4-7` etc. fall through to the correct
// tier without code changes. Shared between `pnpm usage` (scripts/cost/usage.ts)
// and the /admin/usage dashboard so the CLI and the webpage agree on every dollar.
//
// DeepSeek caching (confirmed empirically 2026-06-18):
// the Anthropic-compatible endpoint reports cache hits in Anthropic's EXACT
// shape — `cache_read_input_tokens` carries the cached prefix and `input_tokens`
// EXCLUDES it (cold call: input=1502/read=0; warm: input=94/read=1408, no
// double-count). `cache_creation_input_tokens` is always 0 (DeepSeek auto-caches
// by prefix with no cache-write surcharge; it ignores Anthropic's cache_control).
// So recordUsage + costOf price DeepSeek correctly with no special-casing:
// uncached input at the cache-miss rate, the cached remainder at cacheRead.

type Price = {
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
  webSearch: number;
};

const PRICES: Array<{ match: string; price: Price }> = [
  {
    match: "fable",
    price: {
      input: 10,
      cacheCreate: 12.5,
      cacheRead: 1.0,
      output: 50,
      webSearch: 10,
    },
  },
  {
    match: "opus",
    price: {
      input: 15,
      cacheCreate: 18.75,
      cacheRead: 1.5,
      output: 75,
      webSearch: 10,
    },
  },
  {
    match: "sonnet",
    price: {
      input: 3,
      cacheCreate: 3.75,
      cacheRead: 0.3,
      output: 15,
      webSearch: 10,
    },
  },
  {
    match: "haiku",
    price: {
      input: 1,
      cacheCreate: 1.25,
      cacheRead: 0.1,
      output: 5,
      webSearch: 10,
    },
  },
  // DeepSeek (Anthropic-compatible endpoint). cacheCreate == input because there
  // is no Anthropic-style cache-write surcharge; cacheRead is DeepSeek's cache-hit
  // rate; webSearch is 0 because DeepSeek bills search as tokens (already counted
  // in input/output), not per-request. Specific ids precede the generic "deepseek"
  // fallback — first substring match wins.
  {
    match: "deepseek-v4-flash",
    price: {
      input: 0.14,
      cacheCreate: 0.14,
      cacheRead: 0.0028,
      output: 0.28,
      webSearch: 0,
    },
  },
  {
    match: "deepseek-v4-pro",
    price: {
      input: 0.435,
      cacheCreate: 0.435,
      cacheRead: 0.003625,
      output: 0.87,
      webSearch: 0,
    },
  },
  {
    match: "deepseek",
    price: {
      input: 0.435,
      cacheCreate: 0.435,
      cacheRead: 0.003625,
      output: 0.87,
      webSearch: 0,
    },
  },
];

// Sonnet is the conservative default — anything we forgot to enumerate
// (an unknown model row, a typo) costs more than Haiku but less than
// Opus, so it's the least wrong miss. Looked up by match (not index) so
// inserting a tier above sonnet — e.g. fable — can't silently repoint it.
const FALLBACK_PRICE =
  PRICES.find((p) => p.match === "sonnet")?.price ?? PRICES[0].price;

export function priceFor(model: string): Price {
  for (const { match, price } of PRICES) {
    if (model.includes(match)) return price;
  }
  return FALLBACK_PRICE;
}

export function costOf(r: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  webSearchRequests: number;
}): number {
  const p = priceFor(r.model);
  return (
    (r.inputTokens / 1_000_000) * p.input +
    (r.outputTokens / 1_000_000) * p.output +
    (r.cacheCreationInputTokens / 1_000_000) * p.cacheCreate +
    (r.cacheReadInputTokens / 1_000_000) * p.cacheRead +
    (r.webSearchRequests / 1000) * p.webSearch
  );
}
