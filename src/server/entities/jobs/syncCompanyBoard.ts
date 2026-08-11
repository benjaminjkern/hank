// Scrape a watchlisted company's live board and record the delta. This is the
// shared scrape→persist core behind BOTH callers that pull a company's board:
//   - the scrape_jobs_for_company procedure (runScrapeJobsForCompany, which
//     additionally prescans the delta + shows the result in the panel), and
//   - the walkthrough state machine's on-entry board pull (runBoardScrape).
// One scrape, one upsert, one stamp — so the two paths can't drift.
//
// Deliberately narrow: it does NOT prescan, flip status, or touch the panel.
// Those are caller-specific (the tool triages the delta itself since no state
// machine follows a handoff in the default flow; the walkthrough's own Step 1
// prescans the NEW pool). Soft-fail on a scrape error — the caller keeps
// whatever roles are already on file — and stamp lastScrapedJobsAt only on
// success so a transient board failure retries on the next entry.
//
// It reads and records a learned board reader but never AUTHORS one: authoring
// costs an LLM call, which is a procedure's job (procedures/registry/
// reconBoard/). Everything here completes in one uninterrupted await.

import { BoardReaderOrigin } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { reconOnCooldown } from "@/server/entities/boardReaders/readerHealth";
import {
  recordReaderRun,
  saveBoardReader,
} from "@/server/entities/boardReaders/recordReaderRun";
import { upsertScrapedJobs } from "@/server/entities/jobs/upsertScrapedJobs";
import { scrapeUrl } from "@/server/scrape";
import type { BoardRecipe } from "@/server/scrape/recipe/types";
import { isLearnedSource } from "@/server/scrape/types";
import type { ScrapeFailureKind } from "@/server/scrape/types";
import { nowDate } from "@/utils/now";

export type SyncCompanyBoardResult =
  | {
      ok: true;
      // Total postings on the board this scrape returned.
      totalJobs: number;
      // Postings created as NEW JobInteractions this run (the genuine delta).
      newJobInteractions: number;
      // Postings this pass found gone from the board and delisted.
      delistedJobs: number;
      // Postings missing from the board that were deliberately NOT delisted,
      // because a learned reader read it. The caller must surface this — a
      // silent withhold looks like "their board never changes".
      missingNotDelisted: number;
      // Whether this board was read by an inferred plan rather than a
      // hand-written provider. Drives the one-time hedge in the narration.
      learned: boolean;
      // Set when `totalJobs` is only part of the board — the provider's cap bit
      // or a detail fetch dropped a row. A caller reporting the count to a
      // human or to the agent must say so, or a partial board reads as the
      // whole one. Also why `delistedJobs` is 0 whenever this is set.
      truncatedAt?: number;
      // The scrape's start timestamp — also what lastScrapedJobsAt was stamped to.
      scrapeStartedAt: Date;
    }
  // `kind` is what lets a caller decide whether re-authoring the reader could
  // help. Only "no_reader" / "reader_broken" are worth escalating to recon; an
  // upstream blip must not burn an LLM call.
  | { ok: false; error: string; kind: ScrapeFailureKind };

export async function syncCompanyBoard(args: {
  userId: string;
  companyId: string;
  sourceUrl: string;
  signal?: AbortSignal;
  // Whether to pay for deterministic discovery when nothing recognizes the
  // board. On by default: it's free of LLM cost, and this caller has somewhere
  // to persist what it learns.
  allowProbe?: boolean;
}): Promise<SyncCompanyBoardResult> {
  const scrapeStartedAt = new Date();
  const reader = await loadReader(args.companyId);

  const scrape = await scrapeUrl(args.sourceUrl, {
    ...(args.signal ? { signal: args.signal } : {}),
    // A quarantined plan is skipped, not run — scrapeUrl then falls through to
    // the probe, which may re-derive a working one for free.
    ...(reader?.recipe && !reader.quarantined ? { recipe: reader.recipe } : {}),
    allowProbe: args.allowProbe ?? !reader?.ruledOut,
  });

  if (!scrape.ok) {
    if (reader) {
      await recordReaderRun(reader.id, { ok: false, structural: false });
    }
    return {
      ok: false,
      error: scrape.error,
      kind: scrape.kind ?? "upstream",
    };
  }

  const learned = isLearnedSource(scrape.data.diagnostics);

  // Upsert Job rows + collect the delta (JobInteractions newly created this run).
  // Closure detection (jobs the board no longer returns) also happens here — and
  // for a learned source it MEASURES without writing.
  const delta = await upsertScrapedJobs({
    userId: args.userId,
    companyId: args.companyId,
    jobs: scrape.data.jobs,
    // Carries `truncatedAt`, which is what stops closure detection from
    // delisting the postings a capped scrape never fetched, and the provider
    // discriminator that decides whether closure may write at all.
    diagnostics: scrape.data.diagnostics,
    scrapeStartedAt,
  });

  // The run was thrown away wholesale — a learned reader pointing at another
  // company's board. Nothing was written, so nothing is stamped either, and the
  // reader is quarantined rather than retried three times.
  if (delta.rejected) {
    if (reader) {
      await recordReaderRun(reader.id, { ok: false, structural: true });
    }
    return {
      ok: false,
      error: `learned reader rejected: ${delta.rejected}`,
      kind: "reader_broken",
    };
  }

  // A plan the probe just inferred is worth keeping: next scrape becomes one
  // fetch instead of the whole candidate fan-out.
  const learnedRecipe = scrape.data.diagnostics?.learnedRecipe;
  const readerId = learnedRecipe
    ? await saveBoardReader({
        companyId: args.companyId,
        sourceUrl: args.sourceUrl,
        recipe: learnedRecipe,
        origin: BoardReaderOrigin.PROBE,
        sampleJobUrls: scrape.data.jobs.slice(0, 5).map((j) => j.sourceUrl),
      })
    : reader?.id;

  if (readerId && learned) {
    await recordReaderRun(readerId, {
      ok: true,
      jobs: delta.totalJobs,
      missing: delta.missingNotDelisted,
      openCount: delta.openCount,
      ...(delta.overlap != null ? { overlap: delta.overlap } : {}),
    });
  }

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
    delistedJobs: delta.delistedJobs,
    missingNotDelisted: delta.missingNotDelisted,
    learned,
    ...(scrape.data.diagnostics?.truncatedAt != null
      ? { truncatedAt: scrape.data.diagnostics.truncatedAt }
      : {}),
    scrapeStartedAt,
  };
}

// The reader rides on the Company row we'd be reading anyway, so this costs one
// query rather than a lookup by URL on the hot path.
async function loadReader(companyId: string): Promise<{
  id: string;
  recipe: BoardRecipe | null;
  quarantined: boolean;
  // Recon looked at this board and produced no plan. Caching that verdict is
  // what stops a permanently-unreadable board from re-buying ~25s of
  // speculative discovery on every staleness tick, forever — the failure has to
  // be remembered as deliberately as the success.
  ruledOut: boolean;
} | null> {
  const row = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      boardReader: {
        select: {
          id: true,
          recipe: true,
          health: true,
          reconnedAt: true,
        },
      },
    },
  });
  const reader = row?.boardReader;
  if (!reader) return null;
  const recipe = (reader.recipe as BoardRecipe | null) ?? null;
  return {
    id: reader.id,
    recipe,
    quarantined: reader.health === "QUARANTINED",
    ruledOut:
      recipe == null && reconOnCooldown(reader.reconnedAt ?? null, nowDate()),
  };
}
