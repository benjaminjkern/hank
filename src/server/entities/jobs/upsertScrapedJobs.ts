// Shared scrape-upsert. Callers — the walkthrough's board scrape (first pull for a company),
// scrapeJobsForCompany (the shared scrape core behind the scrape_jobs_for_company
// tool + the walkthrough's on-entry board refresh), the walkthrough state
// machine's step-0 empty-company auto-prep, and retryBlocked — each take the
// array of normalized job records from `scrapeUrl` and persist them via the
// same write transaction.
//
// Behavior:
// - Upserts Job by sourceUrl (existing rows refresh title/location/etc +
//   stamp lastSeenAt; new rows insert with the scan's timestamp).
// - For each upserted Job, ensures a JobInteraction(NEW) exists for the
//   user. Rows that already have a JobInteraction (in any status) are
//   left alone — re-scrapes don't reset status.
// - Logs a SURFACED Event row for each NEW JobInteraction so the audit
//   trail captures when the job first hit the user's pool.
//
// Concurrency: per-job upserts run in parallel with a small fan-out. The
// The first-pull path was already doing this; the re-scrape path was serial.
// Unifying to parallel is uncontroversial — the Job upsert is unique on
// sourceUrl so there are no row-level conflicts, and the per-job
// JobInteraction upsert is keyed by (userId, jobId) which is also unique.

import {
  EventSource,
  JobEventType,
  CompanyEventType,
  JobInteractionStatus,
  Prisma,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { logCompanyEvent } from "@/server/entities/companies/logCompanyEvent";
import type { ScrapeDiagnostics, ScrapedJob } from "@/server/scrape/types";

import { mintJobSlug } from "./jobSlug";
import { roleAttrColumns } from "./roleAttrs";

const UPSERT_CONCURRENCY = 4;

// Closure tuning. CLOSURE_MIN_BOARD: below this many currently-open scraped jobs
// we don't apply the "suspicious mass-closure" guard (small boards swing a lot).
// CLOSURE_FLIP_STATUSES: JobInteraction statuses a taken-down posting drags to
// DELISTED — only the non-terminal set; applied/interviewing/closed rows keep
// their state, because the posting's fate says nothing about an application
// already in flight.
const CLOSURE_MIN_BOARD = 5;
// Fraction of a non-trivial board that can go missing in one pass before we
// assume scraper regression rather than mass takedown. Deliberately well under
// half: `truncatedAt` now catches the partial scrapes a provider ADMITS to, so
// what's left for this guard is the unsignalled kind (a drifted API, a
// forwarded search filter that changed meaning). The costs are asymmetric — a
// false close writes terminal DELISTED across a user's shortlist, a false skip
// just leaves rows stale-open until the next scrape.
const CLOSURE_MAX_MISSING_RATIO = 0.34;
const CLOSURE_FLIP_STATUSES = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.DEFERRED,
] as const;

type UpsertScrapedJobsResult = {
  totalJobs: number;
  newJobInteractions: number;
  // Postings this pass found gone from the board. 0 also means "we didn't
  // look" — the caller distinguishes the cases from the scrape's own
  // `truncatedAt`; the other two skips are logged, not returned.
  delistedJobs: number;
  scrapeStartedAt: Date;
};

export async function upsertScrapedJobs(args: {
  userId: string;
  companyId: string;
  jobs: ScrapedJob[];
  // Optional scan timestamp. When omitted, the function stamps `new Date()`
  // at entry. Callers that need a specific timestamp (e.g. scrapeJobsForCompany,
  // which stamps lastScrapedJobsAt to the same instant) pass it explicitly.
  scrapeStartedAt?: Date;
  // Straight off ScrapeResult.data. A `truncatedAt` here means the board came
  // back partial, which disables closure detection for this pass — pass it
  // through rather than dropping it, or live postings get delisted.
  diagnostics?: ScrapeDiagnostics;
}): Promise<UpsertScrapedJobsResult> {
  const scrapeStartedAt = args.scrapeStartedAt ?? new Date();
  // Company slug drives the job-slug prefix. Loaded once; falls back to name.
  const company = await prisma.company.findUnique({
    where: { id: args.companyId },
    select: { slug: true, name: true },
  });
  const newFlags = await mapWithConcurrency(
    args.jobs,
    UPSERT_CONCURRENCY,
    async (job) => {
      const upJob = await prisma.job.upsert({
        where: { sourceUrl: job.sourceUrl },
        update: {
          title: job.title,
          rawContent: job.rawContent,
          ...roleAttrColumns(job),
          attributes: job.attributes
            ? (job.attributes as Prisma.InputJsonValue)
            : Prisma.DbNull,
          lastSeenAt: scrapeStartedAt,
        },
        create: {
          companyId: args.companyId,
          title: job.title,
          sourceUrl: job.sourceUrl,
          rawContent: job.rawContent,
          ...roleAttrColumns(job),
          attributes: job.attributes
            ? (job.attributes as Prisma.InputJsonValue)
            : Prisma.DbNull,
          lastSeenAt: scrapeStartedAt,
        },
      });
      // Mint a slug on first sight (new row) or lazily backfill a legacy
      // null-slug row this scrape touched. Immutable once set — a title change
      // on re-scrape does NOT re-slug (the slug is a stable permalink).
      if (upJob.slug == null) {
        await mintJobSlug(upJob.id, {
          companySlug: company?.slug ?? null,
          companyName: company?.name ?? null,
          title: job.title,
          location: job.location ?? null,
          department: job.department ?? null,
        });
      }
      const existing = await prisma.jobInteraction.findUnique({
        where: { userId_jobId: { userId: args.userId, jobId: upJob.id } },
        select: { id: true },
      });
      if (existing) return false;
      const created = await prisma.jobInteraction.create({
        data: {
          userId: args.userId,
          jobId: upJob.id,
          status: JobInteractionStatus.NEW,
        },
        select: { id: true },
      });
      await prisma.jobEvent.create({
        data: {
          jobInteractionId: created.id,
          type: JobEventType.SURFACED,
          occurredAt: new Date(),
          source: EventSource.CHAT_EXTRACTED,
        },
      });
      return true;
    },
  );
  const newJobInteractions = newFlags.filter(Boolean).length;

  // One collapsed company-feed row for the surfacing (not one per SURFACED job).
  // The per-job SURFACED JobEvents still land above (first-pulled-up marker).
  if (newJobInteractions > 0) {
    await logCompanyEvent({
      userId: args.userId,
      companyId: args.companyId,
      type: CompanyEventType.SCRAPE_FOUND,
      occurredAt: scrapeStartedAt,
      notes: `Found ${newJobInteractions} new role${newJobInteractions === 1 ? "" : "s"}`,
    });
  }

  // ── Closure detection ──────────────────────────────────────────────────
  // Scrape-sourced jobs at this company that the board no longer returns were
  // taken down: stamp Job.closedAt (global) + flip every non-terminal
  // JobInteraction (any user) to DELISTED. Skipped outright on a truncated
  // scrape, and guarded against a flaky partial one. Manual create_job rows
  // (sourceUrl null) are never touched. No-op on a first scrape (nothing
  // pre-existing to miss).
  const closure = await detectAndApplyClosures({
    userId: args.userId,
    companyId: args.companyId,
    scrapedJobs: args.jobs,
    closedAt: scrapeStartedAt,
    truncatedAt: args.diagnostics?.truncatedAt,
  });

  // A successful scrape produced this call (every caller checks scrape.ok
  // first), so the company's ATS is confirmed scrapeable — stamp the global
  // flag so a later lookup doesn't re-hunt a URL that already works.
  // Idempotent; an empty board still counts (the ATS responded, just no roles).
  await prisma.company.update({
    where: { id: args.companyId },
    data: { atsVerifiedAt: scrapeStartedAt },
  });
  return {
    totalJobs: args.jobs.length,
    newJobInteractions,
    delistedJobs: closure.delisted,
    scrapeStartedAt,
  };
}

// Delist jobs the board no longer returns: global Job.closedAt + a status flip
// to DELISTED, with a DELISTED JobEvent, on every affected user's non-terminal
// JobInteraction. Bails on a truncated scrape, an empty one, or a suspicious
// mass-disappearance — DELISTED is terminal and there's no un-delist path, so
// leaving rows stale-open (self-correcting next scrape) always beats closing
// live postings.
//
// This is the one sanctioned bypass of the `logJobEvents` seam, and it stays
// one: that seam is per-user by construction (planJobEvents takes a userId), so
// routing N users through it means N plans — an await-loop in entities/, which
// is the rule this repo cares most about. Its own read-outside-the-transaction
// is justified by "a run holds its session exclusively", and that premise is
// simply false for another user's rows. So the pair below is hand-rolled, and
// carries the one thing the seam would have given us for free: the stance
// clear-on-transition, without which a delisted row keeps a stale board mark.
async function detectAndApplyClosures(args: {
  userId: string;
  companyId: string;
  scrapedJobs: ScrapedJob[];
  closedAt: Date;
  truncatedAt: number | undefined;
}): Promise<{ delisted: number }> {
  // A capped or lossy scrape is not evidence anything came down — the postings
  // it never fetched are missing from `seen` exactly like taken-down ones.
  // Logged because this permanently disables closures on boards bigger than the
  // provider's cap, which otherwise looks like "their board never changes".
  if (args.truncatedAt != null) {
    console.warn(
      `[upsertScrapedJobs] skipping closure for company ${args.companyId}: ` +
        `scrape returned a partial board (${args.truncatedAt} jobs).`,
    );
    return { delisted: 0 };
  }

  const seen = new Set(args.scrapedJobs.map((j) => j.sourceUrl));
  // Empty scrape — never close on no signal.
  if (seen.size === 0) return { delisted: 0 };

  const open = await prisma.job.findMany({
    where: {
      companyId: args.companyId,
      sourceUrl: { not: null },
      closedAt: null,
    },
    select: { id: true, sourceUrl: true },
  });
  const gone = open.filter(
    (j) => j.sourceUrl != null && !seen.has(j.sourceUrl),
  );
  if (gone.length === 0) return { delisted: 0 };

  // Suspicious mass-closure guard: a scrape dropping this much of a non-trivial
  // board is more likely a scraper regression than a real mass takedown.
  if (
    open.length >= CLOSURE_MIN_BOARD &&
    gone.length > open.length * CLOSURE_MAX_MISSING_RATIO
  ) {
    console.warn(
      `[upsertScrapedJobs] skipping closure for company ${args.companyId}: ` +
        `${gone.length}/${open.length} scraped jobs missing this pass (suspected partial scrape).`,
    );
    return { delisted: 0 };
  }

  const goneIds = gone.map((j) => j.id);
  // Capture the JobInteractions we're about to delist BEFORE the flip — updateMany
  // returns no ids, and we need them to log one DELISTED JobEvent per row (the
  // posting-came-down marker on each affected user's job timeline). No userId
  // filter: Job.closedAt is a global fact about the posting, so every user
  // watching it gets the projection in the same pass.
  const affected = await prisma.jobInteraction.findMany({
    where: {
      jobId: { in: goneIds },
      status: { in: [...CLOSURE_FLIP_STATUSES] },
    },
    select: { id: true },
  });
  await prisma.job.updateMany({
    where: { id: { in: goneIds } },
    data: { closedAt: args.closedAt },
  });
  if (affected.length > 0) {
    // Flip + event commit atomically so a status can't strand without its event.
    await prisma.$transaction([
      prisma.jobInteraction.updateMany({
        where: { id: { in: affected.map((a) => a.id) } },
        data: {
          status: JobInteractionStatus.DELISTED,
          // Clear-on-transition: a role that just came down can't still be
          // carrying a shortlist stance from the round it was proposed in.
          proposedVerdict: null,
          placementVerdict: null,
          proposedReason: null,
          proposedBy: null,
          proposedAt: null,
        },
      }),
      prisma.jobEvent.createMany({
        data: affected.map((a) => ({
          jobInteractionId: a.id,
          type: JobEventType.DELISTED,
          occurredAt: args.closedAt,
          source: EventSource.CHAT_EXTRACTED,
        })),
      }),
    ]);
  }

  // One collapsed company-feed row for the batch, mirroring SCRAPE_FOUND above
  // (the per-user DELISTED JobEvents still fan out). Worded as a takedown, not
  // a decision — the close-reason JOBS_CLOSED rows written by the scan paths
  // say "Closed N roles: not a match", which is a judgement this isn't.
  if (goneIds.length > 0) {
    await logCompanyEvent({
      userId: args.userId,
      companyId: args.companyId,
      type: CompanyEventType.JOBS_CLOSED,
      occurredAt: args.closedAt,
      notes: `${goneIds.length} role${goneIds.length === 1 ? "" : "s"} came down off the board`,
    });
  }

  return { delisted: goneIds.length };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        // eslint-disable-next-line no-await-in-loop -- this await IS the concurrency limit: N workers draining a shared cursor is how the pool stays bounded
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
