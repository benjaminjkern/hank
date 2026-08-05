// The abort signal for the scrape currently running, carried ambiently.
//
// Every outbound request in this layer has to die when the user hits Stop, but
// the requests are 24 `fetchText` calls plus a handful of raw `fetch`es spread
// across 19 provider files, most of them several `fetchAll` frames below
// `scrapeUrl`. Threading a signal parameter down each of those chains has the
// wrong failure mode: a site that doesn't get one still compiles and still
// scrapes — it just silently ignores Stop, which is the bug being fixed. So the
// signal is set ONCE at the `scrapeUrl` boundary and read at each fetch, the
// same trade platform/usage/captureContext.ts makes for run-tree capture. A
// provider added later is covered without doing anything.
//
// ALS caveat (same as captureContext): only wrap non-generator async boundaries.
// `scrapeUrl` is a plain async function, so everything it awaits inherits the
// scope.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<AbortSignal>();

// Run `fn` with `signal` as the ambient scrape signal. A caller with no signal
// (background jobs, scripts) runs `fn` unwrapped, so `currentScrapeSignal()`
// stays undefined and every fetch keeps its plain timeout.
export function withScrapeSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return signal ? storage.run(signal, fn) : fn();
}

export function currentScrapeSignal(): AbortSignal | undefined {
  return storage.getStore();
}

// The signal every fetch in this layer should use: its own timeout, plus the
// ambient scrape signal when there is one.
//
// `AbortSignal.timeout` rather than a hand-rolled controller because it aborts
// with a **TimeoutError**, which `isUserAbortError` correctly does NOT treat as
// a user Stop — a manual `controller.abort()` raises an indistinguishable
// AbortError, so a slow board read looked exactly like the user pressing Stop.
export function scrapeFetchSignal(timeoutMs: number): AbortSignal {
  const ambient = currentScrapeSignal();
  const timeout = AbortSignal.timeout(timeoutMs);
  return ambient ? AbortSignal.any([ambient, timeout]) : timeout;
}
