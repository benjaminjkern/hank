import { detectAts, scrapeViaAts } from "./ats";
import { probeGenericBoard } from "./generic/genericProbe";
import { runBoardRecipe } from "./recipe/runRecipe";
import { withScrapeSignal } from "./scrapeSignal";

import type { BoardRecipe } from "./recipe/types";
import type { AtsProvider, ScrapeResult } from "./types";

type ScrapeOpts = {
  // Forwarded from the chat loop. Tears down the in-flight board fetch when the
  // user hits Stop; see scrapeSignal.ts for how it reaches each provider.
  signal?: AbortSignal;
  // A previously learned plan for this board. Tried after the wired providers
  // and before the probe, so it's a fast path, never an override — a board that
  // later gains a real provider file starts using it immediately.
  recipe?: BoardRecipe;
  // Whether to pay for deterministic discovery on a miss. Off by default
  // because it costs up to ~25s of speculative requests; the caller turns it on
  // when it has somewhere to persist the result (or is a one-shot verify).
  allowProbe?: boolean;
};

// Lean test-scrape result used by the basic-info hunter sub-agent to verify a
// candidate URL without polluting the conversation context (or the DB) with
// full job postings. The hunter only needs counts + a sample of titles to
// confirm "this URL produces real jobs."
type TestScrapeResult =
  | {
      ok: true;
      // Always a wired provider — testScrape never runs a recipe (see below).
      provider: AtsProvider;
      jobCount: number;
      sampleTitles: string[]; // up to 5
      companyName: string;
      // Set when jobCount is only the first slice of a bigger board. Material
      // to the hunter's verdict: "this URL produces real jobs" is still true,
      // but "this board has 42 roles" would not be.
      truncatedAt?: number;
    }
  | { ok: false; error: string; provider?: AtsProvider };

// Verify a candidate careers URL without writing anything to the DB. The
// orchestrator runs the real scrape (and the upsert) exactly once after the
// hunter commits — see huntThenFinalize in
// procedures/registry/walkthrough/boardScrape.ts.
//
// Deliberately WIRED-PROVIDERS-ONLY, no probe: this is the function
// probeAtsBoards fans out across ~24 slug candidates in parallel, and paying
// ~25s of speculative discovery per candidate would multiply catastrophically.
// The generic probe hangs off resolveBoardFromCareersPage instead, which runs
// once, on the detect-miss path.
export async function testScrape(url: string): Promise<TestScrapeResult> {
  const handler = detectAts(url);
  if (!handler) {
    return {
      ok: false,
      error: `not a recognized ATS board URL (see scrape/ats/providers/ for the supported set — greenhouse, lever, ashby, workday, teamtailor, gem, smartrecruiters, workable, icims, eightfold, rippling, oracle, jazzhr, and the bespoke big-tech boards). Point test_scrape at the company's careers page instead — it resolves branded Workday / iCIMS sites and can work out how to read an unrecognized board — or use fetch_url to look for ATS links.`,
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
    ...(result.data.diagnostics?.truncatedAt != null
      ? { truncatedAt: result.data.diagnostics.truncatedAt }
      : {}),
  };
}

// Full scrape. Three readers in priority order — a wired ATS provider, a stored
// recipe, then deterministic discovery — and all three are deterministic: no
// LLM runs in this path and no LLM-authored job list exists. A learned board is
// executed by the recipe runner from a stored plan; the model that authored
// that plan (procedures/registry/reconBoard/) never sees or emits a posting.
//
// A user Stop THROWS out of here rather than returning `{ok:false}`, and that
// distinction is load-bearing: callers read a failed scrape as "this board is
// unreadable" and set the company BLOCKED / CANNOT_SCRAPE (the walkthrough's
// board scrape does exactly that). Degrading an abort into that shape would let
// pressing Stop permanently set companies aside. Throwing instead lands in the
// abort handling every tool dispatch already has.
export async function scrapeUrl(
  url: string,
  opts?: ScrapeOpts,
): Promise<ScrapeResult> {
  opts?.signal?.throwIfAborted();
  const result = await withScrapeSignal(opts?.signal, () =>
    readBoard(url, opts),
  );
  // Whatever the reader did with the abort — rethrown, or caught and shaped
  // into an error string — the signal is the authority on why we're here.
  opts?.signal?.throwIfAborted();
  return result;
}

async function readBoard(
  url: string,
  opts: ScrapeOpts | undefined,
): Promise<ScrapeResult> {
  const handler = detectAts(url);
  if (handler) {
    const result = await scrapeViaAts(handler);
    // A wired provider's failure is always upstream — its endpoint is known
    // good, so a miss is the network or the board being down, never a reader
    // that needs re-authoring.
    return result.ok ? result : { ...result, kind: "upstream" };
  }

  if (opts?.recipe) {
    const result = await runBoardRecipe(opts.recipe, { boardUrl: url });
    if (result.ok) return result;
    // The stored plan no longer reads this board. That IS a re-authoring
    // signal, so fall through to the probe (which may re-derive it for free)
    // and report the kind that lets a caller escalate to recon.
    const probed = opts.allowProbe ? await probe(url) : null;
    return probed ?? { ...result, kind: "reader_broken" };
  }

  if (opts?.allowProbe) {
    const probed = await probe(url);
    if (probed) return probed;
  }

  return {
    ok: false,
    error: `no reader for ${url}: not a recognized ATS board, and nothing readable found on it. Set a board URL with update_company, or surface as CANNOT_SCRAPE.`,
    kind: "no_reader",
  };
}

async function probe(url: string): Promise<ScrapeResult | null> {
  const outcome = await probeGenericBoard(url);
  if (!outcome.ok) return null;
  return {
    ok: true,
    data: {
      ...outcome.data,
      diagnostics: {
        ...(outcome.data.diagnostics ?? {
          provider: "recipe",
          fetchedUrl: url,
          pageLength: 0,
          pageSnippet: "",
        }),
        learnedRecipe: outcome.recipe,
        technique: outcome.technique,
      },
    },
  };
}
