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
import { urlHost } from "@/utils/url";

import { narrateCompanyBlock, narrateCompanyCaughtUp } from "./narration";
import { yieldStateChange } from "./yieldStateChange";

import type { WalkthroughArgs } from "./types";

// How stale a company's last board scrape can be before walkthrough-entry
// re-scrapes it. 24h: a returning-the-next-day user picks up new postings on
// entry; same-session re-entries (lastScrapedJobsAt just stamped) skip it.
const SCRAPE_STALENESS_MS = 24 * 60 * 60 * 1000;

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

  const fetched = await syncCompanyBoard({
    userId: args.userId,
    companyId,
    sourceUrl,
    signal: args.signal,
  });

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
    const blocked = {
      reason: CompanyBlockReason.CANNOT_SCRAPE,
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
      `Found ${fetched.totalJobs} job posting${fetched.totalJobs === 1 ? "" : "s"}${fetched.newJobInteractions > 0 ? ` (${fetched.newJobInteractions} new)` : ""} — taking a closer look…`,
    );
  }

  // Fall through to Step 1, which prescans + scans whatever is NEW.
  return { wrapped: false, delta: fetched.newJobInteractions };
}
