// Whether this deployment can drive a real browser at all, asked BEFORE
// anything tries.
//
// The reference deployment runs on a serverless host with no Chromium binary,
// so the honest default is "no". Previously the only answer was to attempt a
// launch and let it throw, which meant Playwright loaded, a process spawn was
// attempted, and the resulting error said "chromium unavailable" — machinery
// leaking into a message that should say "this board needs a rendered browser,
// which I can't do from here".
//
// Set HEADLESS_BROWSER=local in .env to opt a machine in. Local dev and the
// scripts under scripts/ats/ are the intended users: a browser there is a
// RECIPE-AUTHORING tool (see scripts/ats/research-board.ts), not a scraping
// tier — it renders a board once to discover the JSON endpoint the board itself
// calls, and writes that into a recipe prod can run with no browser at all.
//
// A future remote-browser service is one more variant here plus a branch in
// `withBrowser`; nothing else in the codebase asks the question.

export type BrowserCapability = "local" | "none";

export class BrowserUnavailableError extends Error {
  constructor(what: string) {
    super(
      `${what} needs a rendered browser, which this deployment can't run. Set HEADLESS_BROWSER=local to enable it here.`,
    );
    this.name = "BrowserUnavailableError";
  }
}

export function browserCapability(): BrowserCapability {
  return process.env.HEADLESS_BROWSER === "local" ? "local" : "none";
}

// Run `fn` against a browser context, or throw before loading Playwright at
// all. The pre-check is the point: a caller that asks first never pays the
// import, and its failure message is about the BOARD rather than about us.
export async function withBrowser<T>(
  what: string,
  fn: (ctx: import("playwright").BrowserContext) => Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs?: number; userAgent?: string } = {},
): Promise<T> {
  if (browserCapability() === "none") throw new BrowserUnavailableError(what);
  // Lazy so Playwright is never loaded on a deployment that can't use it.
  const headless = await import("./headless");
  return await headless.withHeadlessContext(fn, opts);
}
