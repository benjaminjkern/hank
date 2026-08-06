// Verify a careers URL produces real jobs, WITHOUT writing anything.
//
// Sub-agent-only — not in `hankToolsFor`. It's the basic-info hunter's
// verifier: the canonical scan writes (Job upserts, JobInteraction creates,
// SURFACED events, the lastScrapedJobsAt stamp), and the hunter tests 3-5
// candidate URLs before finding the right one, so letting it run the real scan
// would pollute the user's DB with the wrong company's board. The orchestrator
// runs the real scan exactly once, after the hunter commits.
//
// On a DETECT miss (the URL isn't a recognized board at all) it falls back to
// resolveBoardFromCareersPage, which is the only way to reach an enterprise
// Workday board (unguessable shard) or a branded iCIMS career site. A
// recognized board that merely failed to scrape is a dead board and reports as
// one — so a failed slug guess never pays for a page fetch.

import { z } from "zod";

import { testScrape } from "@/server/scrape";
import { resolveBoardFromCareersPage } from "@/server/scrape/resolveBoardFromCareersPage";
import { withScrapeSignal } from "@/server/scrape/scrapeSignal";
import { normalizeUrlInput } from "@/utils/url";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const testScrapeTool: ToolDef<{ url: string }> = {
  name: "test_scrape",
  description:
    "Verify a careers URL produces real jobs, without writing anything to the database. Returns {ok, provider, jobCount, sampleTitles, companyName} on success or {ok:false, error} on failure. Free + fast deterministic JSON fetches, no LLM.\n\nPass EITHER a board URL or a careers page. Recognized boards (greenhouse, lever, ashby, workday, teamtailor, gem, smartrecruiters, workable, icims, eightfold, rippling, oracle, jazzhr, amazon, apple, google, meta, netflix, shopify) are tested directly. If the URL ISN'T a recognized board — a company homepage, `careers.{company}.com`, a 'Life at {Company}' page — this automatically reads the page and tries to resolve the real board behind it, which is the ONLY way to reach an enterprise Workday board (the wd1..wd108+ shard is unguessable) or a branded iCIMS career site. So when slug guesses miss, just point this at the company's careers page. On success it tells you the board URL to report as sourceUrl — use THAT, not the page you passed in.\n\nTreat jobCount<2 as a failure: boards with a single 'open application' template entry pass this gate without being real boards.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "A board URL to verify, OR a careers page / homepage to resolve a board from.",
      },
    },
    required: ["url"],
  },
  parser: z.object({
    url: z.string().transform(normalizeUrlInput).pipe(z.string().url()),
  }),
  async handle({ url }, ctx) {
    const r = await withScrapeSignal(ctx.signal, () => testScrape(url));
    ctx.signal?.throwIfAborted();
    if (r.ok) {
      return { content: describeBoard(`test_scrape ${url}`, url, r) };
    }

    // A recognized board that failed to scrape is a dead board — report it.
    // Only a DETECT miss (no provider) means "this wasn't a board at all",
    // which is exactly the careers-page case worth resolving.
    if (r.provider) {
      return toolError(
        "UPSTREAM_FETCH_FAILED",
        `test_scrape ${url}: failed (${r.provider}) — ${r.error}`,
        "test_scrape:scrape_failed",
      );
    }

    const resolved = await withScrapeSignal(ctx.signal, () =>
      resolveBoardFromCareersPage(url),
    );
    ctx.signal?.throwIfAborted();
    if (!resolved.ok) {
      return toolError(
        "UPSTREAM_FETCH_FAILED",
        `test_scrape ${url}: not a recognized board, and ${resolved.reason}.`,
        "test_scrape:no_board_found",
      );
    }
    const b = resolved.board;
    return {
      content:
        describeBoard(
          `test_scrape ${url}: not a board itself, but resolved ${b.boardUrl} from the page`,
          b.boardUrl,
          b,
        ) + `\n\nReport ${b.boardUrl} as sourceUrl (not ${url}).`,
    };
  },
};

function describeBoard(
  prefix: string,
  boardUrl: string,
  r: {
    provider: string;
    jobCount: number;
    companyName: string;
    sampleTitles: string[];
    truncatedAt?: number;
  },
): string {
  const titles = r.sampleTitles.length
    ? `\nsample titles: ${r.sampleTitles.map((t) => `"${t}"`).join(", ")}`
    : "";
  // A capped board still verifies the URL — jobCount just isn't the board size.
  const partial =
    r.truncatedAt != null
      ? ` (PARTIAL — the first ${r.truncatedAt} of a larger board; the URL is confirmed good, but this is not the board's real size)`
      : "";
  return `${prefix}: ok via ${r.provider}, ${r.jobCount} job${r.jobCount === 1 ? "" : "s"} found at ${boardUrl}${partial}, companyName="${r.companyName}"${titles}`;
}

// Deterministically probe the slug-guessable ATSes for a company.
//
// Replaces the hunter's prose slug-guessing for the easy + domain-style cases:
// generate the obvious name/domain-derived slugs and test_scrape them across
// Greenhouse/Lever/Ashby/Teamtailor/Gem in parallel — free, no LLM, no
// web_search. The slug-candidate logic + cross-product live in scrape/slugProbe.ts
// (pure, unit-tested); this tool is the thin sub-agent wrapper. Returns every
// board with ≥2 real jobs; the hunter validates each hit against the *right*
// company before reporting one (a name-derived slug can collide — the "Arbor"
// failure mode).
