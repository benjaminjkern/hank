import { detectAts, scrapeViaAts } from "./ats";
import { withScrapeSignal } from "./scrapeSignal";

import type { AtsProvider, ScrapeResult } from "./types";

type ScrapeOpts = {
  // Forwarded from the chat loop. Tears down the in-flight board fetch when the
  // user hits Stop; see scrapeSignal.ts for how it reaches each provider.
  signal?: AbortSignal;
};

// Lean test-scrape result used by the basic-info hunter sub-agent to verify a
// candidate URL without polluting the conversation context (or the DB) with
// full job postings. The hunter only needs counts + a sample of titles to
// confirm "this URL produces real jobs."
type TestScrapeResult =
  | {
      ok: true;
      provider: AtsProvider;
      jobCount: number;
      sampleTitles: string[]; // up to 5
      companyName: string;
    }
  | { ok: false; error: string; provider?: AtsProvider };

// Verify a candidate careers URL without writing anything to the DB. The
// orchestrator runs the real scrape (and the upsert) exactly once after the
// hunter commits — see huntThenFinalize in
// procedures/registry/walkthrough/boardScrape.ts. ATS-only by design: there
// is deliberately no generic-HTML LLM fallback, because the right escalation
// when no ATS is found is to surface CANNOT_SCRAPE, so the user can supply a
// URL by hand or the admin can build a new parser.
export async function testScrape(url: string): Promise<TestScrapeResult> {
  const handler = detectAts(url);
  if (!handler) {
    return {
      ok: false,
      error: `not a recognized ATS board URL (see scrape/ats/providers/ for the supported set — greenhouse, lever, ashby, workday, teamtailor, gem, smartrecruiters, workable, icims, eightfold, rippling, oracle, jazzhr, and the bespoke big-tech boards). Point test_scrape at the company's careers page instead — it resolves branded Workday / iCIMS sites — or use fetch_url to look for ATS links.`,
    };
  }
  const result = await scrapeViaAts(handler);
  if (!result.ok)
    return { ok: false, error: result.error, provider: handler.provider };
  return {
    ok: true,
    provider: handler.provider,
    jobCount: result.data.jobs.length,
    sampleTitles: result.data.jobs.slice(0, 5).map((j) => j.title),
    companyName: result.data.companyName,
  };
}

// Full scrape — fully deterministic, single HTTPS call to a recognized ATS's
// JSON API, returns every job with its rawContent in one response. No LLM
// involvement, no cost beyond network. Non-ATS URLs fail; callers should
// either supply an ATS URL or escalate to CANNOT_SCRAPE.
//
// `userId` is vestigial from when there was an LLM fallback that needed cost
// tracking. Kept in the signature for now so call sites don't need to change.
//
// A user Stop THROWS out of here rather than returning `{ok:false}`, and that
// distinction is load-bearing: callers read a failed scrape as "this board is
// unreadable" and set the company BLOCKED / CANNOT_SCRAPE (walkthrough's
// the walkthrough's board scrape does exactly that). Degrading an abort into that shape would
// let pressing Stop permanently set companies aside. Throwing instead lands in
// the abort handling every tool dispatch already has.
export async function scrapeUrl(
  url: string,
  _userId?: string,
  opts?: ScrapeOpts,
): Promise<ScrapeResult> {
  opts?.signal?.throwIfAborted();
  const handler = detectAts(url);
  if (!handler) {
    return {
      ok: false,
      error: `not a recognized ATS board URL (see scrape/ats/providers/ for the supported set). Manual update_company_url with a board URL, or surface as CANNOT_SCRAPE.`,
    };
  }
  const result = await withScrapeSignal(opts?.signal, () =>
    scrapeViaAts(handler),
  );
  // Whatever the provider did with the abort — rethrown, or caught and shaped
  // into an error string — the signal is the authority on why we're here.
  opts?.signal?.throwIfAborted();
  return result;
}
