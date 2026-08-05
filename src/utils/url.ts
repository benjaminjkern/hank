// Normalize agent-supplied URLs that arrive without a scheme.
//
// Agents (the basic-info hunter, the chat agent) routinely hand tools a bare
// hostname like `boards.greenhouse.io/rippling` with no `https://`. Two things
// then break in lockstep:
//   1. zod `z.string().url()` rejects it with a generic "Invalid URL", which
//      tells the agent nothing actionable and burns retries.
//   2. Even past zod, the ATS detectors in src/server/scrape/ats/ anchor on
//      `^https?://`, so `detectAts` would miss the URL anyway.
// Prepending `https://` fixes both at once.
//
// Use as a zod `.transform()` placed *before* `.url()` so the validator sees
// the normalized form:
//   z.string().transform(normalizeUrlInput).pipe(z.string().url())
//
// Inputs that already carry a scheme (`http://`, `https://`, any RFC-3986
// `scheme://`) pass through untouched; protocol-relative `//host` URLs get the
// scheme half only; empty/whitespace passes through so `.url()` still rejects it.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return trimmed;
  if (SCHEME_RE.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

// Host / origin of a URL that may not parse — every caller here is handed a
// string from a scrape, an LLM, or a DB column, so `new URL()` throwing is a
// normal outcome, not a bug. Both return null on an unparseable input and let
// the call site pick its own fallback (the raw string, "unknown", skip).

export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Appends `?key=value` (or `&key=value` when the path already has a query) —
// a no-op when the value is null, so a call site can pass an optional param
// straight through without branching.
export function withQueryParam(
  path: string,
  key: string,
  value: string | null,
): string {
  if (!value) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${key}=${encodeURIComponent(value)}`;
}
