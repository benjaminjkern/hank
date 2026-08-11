// Step 0b of runCompanyArm: pull the company's live board. The ONE scrape path
// in the walkthrough — entered both when the user has no roles on file yet and
// when they do but the board is stale.
//
// `hadRoles` is what those two cases actually differ on, and it decides how a
// bad scrape lands: with roles already on file a failure is a refresh blip, so
// we keep what we have and carry on; with none, there's nothing to show, so the
// company is set aside instead of dead-ending the user on an empty page.

import { CompanyBlockReason } from "@/generated/prisma/client";
import { statusEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import {
  blockCompany,
  caughtUpCompany,
} from "@/server/entities/companies/setCompanyAside";
import { syncCompanyBoard } from "@/server/entities/jobs/syncCompanyBoard";
import { runReconBoard } from "@/server/procedures/registry/reconBoard";
import type { ReconBoardResult } from "@/server/procedures/registry/reconBoard";
import type { ScrapeFailureKind } from "@/server/scrape/types";
import { urlHost } from "@/utils/url";

import { narrateCompanyBlock, narrateCompanyCaughtUp } from "./narration";
import { yieldStateChange } from "./yieldStateChange";

import type { WalkthroughArgs } from "./types";

// How stale a company's last board scrape can be before walkthrough-entry
// re-scrapes it. 24h: a returning-the-next-day user picks up new postings on
// entry; same-session re-entries (lastScrapedJobsAt just stamped) skip it.
const SCRAPE_STALENESS_MS = 24 * 60 * 60 * 1000;

// The two failures a better read-plan could fix. An upstream blip is not one of
// them and must never buy an LLM call.
const RECON_WORTHY_FAILURES = new Set<ScrapeFailureKind>([
  "no_reader",
  "reader_broken",
]);

// Top-level helper so the React Compiler purity lint doesn't flag Date.now() at
// a call site (AGENTS.md). Null = never fetched = stale.
export function isScrapeStale(lastScrapedJobsAt: Date | null): boolean {
  if (!lastScrapedJobsAt) return true;
  return Date.now() - lastScrapedJobsAt.getTime() > SCRAPE_STALENESS_MS;
}

type BoardScrapeResult =
  | { wrapped: true; endedCompanyId: string }
  // Genuinely-new postings this fetch created. Step 1 narrates "N new"
  // separately from the not-yet-reviewed backlog — labelling both "new" reads
  // as a contradiction ("Found 4 new… first pass over 75 new").
  | { wrapped: false; delta: number };

export async function* runBoardScrape(
  companyId: string,
  sourceUrl: string,
  displayName: string,
  hadRoles: boolean,
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, BoardScrapeResult> {
  yield statusEvent(
    hadRoles
      ? `Checking ${displayName}'s board for anything new…`
      : `Scanning ${urlHost(sourceUrl) ?? sourceUrl} for openings…`,
  );

  let fetched = await syncCompanyBoard({
    userId: args.userId,
    companyId,
    sourceUrl,
    signal: args.signal,
  });

  // Unreadable in a way a better read-plan could fix — work one out and try
  // once more, rather than setting the company aside for a board shape we've
  // simply never met. Narrated because it takes a while and the user should
  // know what the pause is.
  let reconVerdict: ReconBoardResult["kind"] | null = null;
  if (!fetched.ok && RECON_WORTHY_FAILURES.has(fetched.kind)) {
    yield statusEvent(
      `${displayName}'s site isn't one of the usual job boards — working out how to read it…`,
    );
    const recon = await runReconBoard({
      ...args,
      companyId,
      companyName: displayName,
      sourceUrl,
    });
    reconVerdict = recon.kind;
    if (recon.kind === "learned") {
      fetched = await syncCompanyBoard({
        userId: args.userId,
        companyId,
        sourceUrl,
        signal: args.signal,
      });
    } else if (recon.kind === "needs_browser") {
      yield statusEvent(
        `${displayName}'s openings only show up once their page fully loads in a browser, which I can't do from here — send me a specific role's link and I can still work it.`,
      );
    }
  }

  if (!fetched.ok) {
    if (hadRoles) {
      yield statusEvent(
        `Couldn't refresh ${displayName}'s board just now — showing what I already have.`,
      );
      return { wrapped: false, delta: 0 };
    }
    yield statusEvent(
      `I couldn't reach ${displayName}'s board just now — I'll set it aside until it's readable again.`,
    );
    // A login or bot wall is a different fact from "we couldn't parse it", and
    // only recon can tell them apart — it's the only thing that looked at the
    // page rather than at an endpoint.
    const blocked = {
      reason:
        reconVerdict === "needs_auth"
          ? CompanyBlockReason.AUTH_WALLED
          : CompanyBlockReason.CANNOT_SCRAPE,
      note: `scrape failed: ${fetched.error}`,
    };
    await blockCompany({ userId: args.userId, companyId, ...blocked });
    yield* yieldStateChange(
      narrateCompanyBlock({ companyId, companyName: displayName, ...blocked }),
    );
    return { wrapped: true, endedCompanyId: companyId };
  }

  if (fetched.totalJobs === 0 && !hadRoles) {
    yield statusEvent(
      `No openings posted at ${displayName} right now — marking caught up.`,
    );
    // Land the right engagement tail (IN_FLIGHT/IN_PROCESS if apps went out
    // this round, else CAUGHT_UP) instead of forcing CAUGHT_UP.
    const { status } = await caughtUpCompany({
      userId: args.userId,
      companyId,
      derive: true,
    });
    yield* yieldStateChange(
      narrateCompanyCaughtUp({ companyId, companyName: displayName, status }),
    );
    return { wrapped: true, endedCompanyId: companyId };
  }

  if (hadRoles) {
    if (fetched.newJobInteractions > 0) {
      yield statusEvent(
        `Found ${fetched.newJobInteractions} new posting${fetched.newJobInteractions === 1 ? "" : "s"} since last time — taking a look…`,
      );
    }
  } else {
    yield statusEvent(
      `Found ${fetched.totalJobs} job posting${fetched.totalJobs === 1 ? "" : "s"}${fetched.newJobInteractions > 0 ? ` (${fetched.newJobInteractions} new)` : ""}${
        fetched.learned
          ? " — their site isn't one of the standard job boards, so I'm reading it directly"
          : ""
      } — taking a closer look…`,
    );
  }

  // Roles we hold open that this read didn't return. On a board we're reading
  // directly we won't mark them gone on our own — the read is good enough to
  // add roles, not to declare one dead — so the user gets the call instead of
  // the board silently looking frozen.
  if (fetched.missingNotDelisted > 0) {
    yield statusEvent(
      `${fetched.missingNotDelisted} role${fetched.missingNotDelisted === 1 ? "" : "s"} I have on file didn't come back in that read. Since I'm reading their site directly I won't mark ${fetched.missingNotDelisted === 1 ? "it" : "them"} gone on my own — say the word if ${fetched.missingNotDelisted === 1 ? "it's" : "they're"} down.`,
    );
  }

  // Fall through to Step 1, which prescans + scans whatever is NEW.
  return { wrapped: false, delta: fetched.newJobInteractions };
}
