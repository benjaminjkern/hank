// Scrape a watchlisted company's live board and record the delta. This is the
// shared scrape→persist core behind BOTH callers that pull a company's board:
//   - the scrape_jobs_for_company procedure (runScrapeJobsForCompany, which
//     additionally prescans the delta + shows the result in the panel), and
//   - the walkthrough state machine's on-entry board pull (runBoardScrape).
// One scrape, one upsert, one stamp — so the two paths can't drift.
//
// Deliberately narrow: it does NOT prescan, flip status, or touch the panel. Those are
// caller-specific (the tool triages the delta itself since no state machine
// follows a handoff in the default flow; the walkthrough's own Step 1 prescans
// the NEW pool). Soft-fail on a scrape error — the caller keeps whatever roles
// are already on file — and stamps lastScrapedJobsAt only on success so a
// transient board failure retries on the next entry instead of looking fresh.

import { prisma } from "@/server/db/prisma";
import { upsertScrapedJobs } from "@/server/entities/jobs/upsertScrapedJobs";
import { scrapeUrl } from "@/server/scrape";

export type SyncCompanyBoardResult =
  | {
      ok: true;
      // Total postings on the board this scrape returned.
      totalJobs: number;
      // Postings created as NEW JobInteractions this run (the genuine delta).
      newJobInteractions: number;
      // The scrape's start timestamp — also what lastScrapedJobsAt was stamped to.
      scrapeStartedAt: Date;
    }
  | { ok: false; error: string };

export async function syncCompanyBoard(args: {
  userId: string;
  companyId: string;
  sourceUrl: string;
  signal?: AbortSignal;
}): Promise<SyncCompanyBoardResult> {
  const scrapeStartedAt = new Date();
  const scrape = await scrapeUrl(
    args.sourceUrl,
    args.userId,
    args.signal ? { signal: args.signal } : undefined,
  );
  if (!scrape.ok) return { ok: false, error: scrape.error };

  // Upsert Job rows + collect the delta (JobInteractions newly created this run).
  // Closure detection (jobs the board no longer returns) also happens here.
  const delta = await upsertScrapedJobs({
    userId: args.userId,
    companyId: args.companyId,
    jobs: scrape.data.jobs,
    scrapeStartedAt,
  });

  await prisma.companyInteraction.update({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    data: { lastScrapedJobsAt: scrapeStartedAt },
  });

  return {
    ok: true,
    totalJobs: delta.totalJobs,
    newJobInteractions: delta.newJobInteractions,
    scrapeStartedAt,
  };
}
