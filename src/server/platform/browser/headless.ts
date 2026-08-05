import {
  chromium,
  type Browser,
  type Page,
  type BrowserContext,
} from "playwright";

// Singleton headless-Chromium launcher. Most ATSes expose unauthenticated JSON
// endpoints and need nothing here — this is the fallback for boards whose apply
// form (or, rarely, whose listing) only exists as JS-rendered HTML with no
// callable API. The cold launch (~3s) is paid ONCE per server lifetime: the
// browser is cached on globalThis (so a Next.js HMR reload reuses it rather than
// leaking a process) and each call gets a fresh, isolated context+page.
//
// DEPLOY NOTE: the Chromium binary is downloaded by `playwright install
// chromium` (run locally + must run in the deploy build — the hosting platform / containers:
// `playwright install --with-deps chromium`). If the binary is absent (or the
// sandbox blocks process spawn) getBrowser() throws HeadlessUnavailableError;
// every caller catches it and degrades to {status:"unsupported"} so prod never
// crashes — it just falls back to asking the user to fill the form.

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Resource types that never matter for scraping text/forms — blocking them cuts
// apply-page render time roughly in half and avoids loading tracker scripts that
// keep the network busy forever (which is why `networkidle` waits hang).
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export class HeadlessUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `headless chromium unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "HeadlessUnavailableError";
  }
}

const globalForHeadless = globalThis as unknown as {
  __hankBrowser: Promise<Browser> | undefined;
};

async function getBrowser(): Promise<Browser> {
  const existing = globalForHeadless.__hankBrowser;
  if (existing) {
    try {
      const b = await existing;
      if (b.isConnected()) return b;
    } catch {
      /* fall through to relaunch */
    }
  }
  const launch = chromium
    .launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    })
    .catch((err) => {
      // Reset the cache so the next call retries instead of re-awaiting a
      // permanently-rejected promise.
      globalForHeadless.__hankBrowser = undefined;
      throw new HeadlessUnavailableError(err);
    });
  globalForHeadless.__hankBrowser = launch;
  return await launch;
}

type HeadlessPageOpts = {
  signal?: AbortSignal;
  // Per-call default for page.goto / waitForSelector / etc. Defaults to 30s.
  timeoutMs?: number;
  userAgent?: string;
  // Block images/media/fonts (default true). Disable only if a board needs them.
  blockHeavyResources?: boolean;
};

// Run `fn` against a fresh, isolated browser context that is always torn down
// afterwards. The context lets a caller open several pages concurrently (e.g. a
// list page + fanned-out detail pages). Throws HeadlessUnavailableError if
// Chromium can't launch — callers translate that to an `unsupported`/`error`
// envelope. Use withHeadlessPage when you only need a single page.
export async function withHeadlessContext<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  opts: HeadlessPageOpts = {},
): Promise<T> {
  const browser = await getBrowser();
  const context: BrowserContext = await browser.newContext({
    userAgent: opts.userAgent ?? DEFAULT_UA,
    javaScriptEnabled: true,
  });
  context.setDefaultTimeout(opts.timeoutMs ?? 30_000);
  if (opts.blockHeavyResources !== false) {
    await context.route("**/*", (route) => {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
        return route.abort();
      }
      return route.continue();
    });
  }
  const onAbort = () => {
    context.close().catch(() => {});
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      await context.close().catch(() => {});
      throw new Error("aborted");
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fn(context);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await context.close().catch(() => {});
  }
}

// Run `fn` against a single fresh page (most callers). See withHeadlessContext
// when you need to open multiple pages concurrently.
export async function withHeadlessPage<T>(
  fn: (page: Page) => Promise<T>,
  opts: HeadlessPageOpts = {},
): Promise<T> {
  return await withHeadlessContext((ctx) => ctx.newPage().then(fn), opts);
}

// True if Chromium can launch in this environment. Cheap probe for scripts /
// startup checks; the launch is cached so this doesn't cost an extra browser.
export async function isHeadlessAvailable(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch {
    return false;
  }
}

// Close the shared browser. Long-lived servers never call this (the singleton is
// the point); one-shot scripts MUST call it before exit or the Chromium process
// keeps the event loop alive and the script hangs.
export async function closeHeadless(): Promise<void> {
  const existing = globalForHeadless.__hankBrowser;
  globalForHeadless.__hankBrowser = undefined;
  if (!existing) return;
  try {
    const b = await existing;
    await b.close();
  } catch {
    /* already gone */
  }
}
