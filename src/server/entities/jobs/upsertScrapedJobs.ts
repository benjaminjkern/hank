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
import type { ScrapedJob } from "@/server/scrape/types";

import { mintJobSlug } from "./jobSlug";
import { roleAttrColumns } from "./roleAttrs";

const UPSERT_CONCURRENCY = 4;

// Closure tuning. CLOSURE_MIN_BOARD: below this many currently-open scraped jobs
// we don't apply the "suspicious mass-closure" guard (small boards swing a lot).
// CLOSURE_FLIP_STATUSES: JobInteraction statuses a closed posting drags to CLOSED —
// only the non-terminal set; applied/interviewing/skipped rows keep their state.
const CLOSURE_MIN_BOARD = 5;
const CLOSURE_FLIP_STATUSES = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.DEFERRED,
] as const;

type UpsertScrapedJobsResult = {
  totalJobs: number;
  newJobInteractions: number;
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
  // JobInteraction (any user) to CLOSED. Guarded against a flaky partial scrape
  // mass-closing a board. Manual create_job rows (sourceUrl null) are never
  // touched. No-op on a first scrape (nothing pre-existing to miss).
  await detectAndApplyClosures(args.companyId, args.jobs, scrapeStartedAt);

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
    scrapeStartedAt,
  };
}

// Close jobs the board no longer returns. Global Job.closedAt + a per-user
// status flip to CLOSED for non-terminal JobInteractions. Bails on an empty scrape
// or a suspicious mass-disappearance (likely a partial/regressed scrape, not a
// real takedown) — better to leave stale-open than to wrongly close a board.
async function detectAndApplyClosures(
  companyId: string,
  scrapedJobs: ScrapedJob[],
  closedAt: Date,
): Promise<void> {
  const seen = new Set(scrapedJobs.map((j) => j.sourceUrl));
  if (seen.size === 0) return; // empty scrape — never close on no signal.

  const open = await prisma.job.findMany({
    where: { companyId, sourceUrl: { not: null }, closedAt: null },
    select: { id: true, sourceUrl: true },
  });
  const gone = open.filter(
    (j) => j.sourceUrl != null && !seen.has(j.sourceUrl),
  );
  if (gone.length === 0) return;

  // Suspicious mass-closure guard: a scrape that drops >50% of a non-trivial
  // board is more likely a scraper regression than a real mass takedown.
  if (open.length >= CLOSURE_MIN_BOARD && gone.length > open.length * 0.5) {
    console.warn(
      `[upsertScrapedJobs] skipping closure for company ${companyId}: ` +
        `${gone.length}/${open.length} scraped jobs missing this pass (suspected partial scrape).`,
    );
    return;
  }

  const goneIds = gone.map((j) => j.id);
  // Capture the JobInteractions we're about to delist BEFORE the flip — updateMany
  // returns no ids, and we need them to log one DELISTED JobEvent per row (the
  // posting-came-down marker on each affected user's job timeline).
  const affected = await prisma.jobInteraction.findMany({
    where: {
      jobId: { in: goneIds },
      status: { in: [...CLOSURE_FLIP_STATUSES] },
    },
    select: { id: true },
  });
  await prisma.job.updateMany({
    where: { id: { in: goneIds } },
    data: { closedAt },
  });
  if (affected.length > 0) {
    // Flip + event commit atomically so a status can't strand without its event.
    await prisma.$transaction([
      prisma.jobInteraction.updateMany({
        where: { id: { in: affected.map((a) => a.id) } },
        data: { status: JobInteractionStatus.DELISTED },
      }),
      prisma.jobEvent.createMany({
        data: affected.map((a) => ({
          jobInteractionId: a.id,
          type: JobEventType.DELISTED,
          occurredAt: closedAt,
          source: EventSource.CHAT_EXTRACTED,
        })),
      }),
    ]);
  }
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
