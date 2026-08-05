// Domain core for creating Job records manually (referrals, email-only postings,
// historical applications, recruiter-pitch batches) — the scrape path is
// upsertScrapedJobs. Shared behind the create_jobs tool: creates each Job + its
// JobInteraction (NEW, or PITCHED when linked to a lead) + the SURFACED seed
// event in one transaction, then mints slugs. Mirror of
// entities/opportunities/createOpportunities.
//
// Works purely in ids — resolving the agent's company/opportunity slugs → ids,
// the focused-company fallback, and the duplicate-sourceUrl pre-check are the
// tool layer's job.

import {
  EventSource,
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { mintJobSlug } from "./jobSlug";
import { roleAttrColumns, type RoleAttrs } from "./roleAttrs";

// One job to create, with the agent's slugs already resolved to ids. `isPitched`
// is derived from opportunityId (a lead-linked role starts PITCHED with no
// SURFACED event). companySlug/companyName ride along for the slug mint + label.
export type CreateJobInput = Partial<RoleAttrs> & {
  companyId: string | null;
  companyName: string | null;
  companySlug: string | null;
  opportunityId: string | null;
  title: string;
  sourceUrl?: string | null;
  rawContent?: string | null;
};

export type CreatedJob = {
  jobId: string;
  slug: string | null;
  title: string;
  companyLabel: string;
  isPitched: boolean;
  opportunityId: string | null;
};

// createManyAndReturn hands rows back in input order — Postgres returns a plain
// multi-row INSERT's RETURNING rows in VALUES order, and that is what every
// `[i]` below relies on to pair a job with its interaction and its slug. Getting
// it wrong would silently attach the wrong role to the wrong row, so the
// assumption is checked rather than trusted: this compares a field we round-trip
// anyway and throws before anything downstream reads a mismatched pair.
function assertAligned(got: string[], want: string[], what: string): void {
  const misaligned =
    got.length !== want.length || got.some((v, i) => v !== want[i]);
  if (misaligned) {
    throw new Error(
      `${what} createManyAndReturn came back out of input order — refusing to pair rows by index`,
    );
  }
}

export async function createJobs(args: {
  userId: string;
  items: CreateJobInput[];
}): Promise<CreatedJob[]> {
  const { userId, items } = args;

  const now = new Date();

  // Three statements for any number of jobs, not three per job. Jobs first
  // (their ids are what the interactions reference), then interactions (whose
  // ids the seed events reference) — createManyAndReturn hands both back in
  // input order, so nothing needs a round trip per row to learn an id.
  const created = await prisma.$transaction(async (tx) => {
    const jobs = await tx.job.createManyAndReturn({
      data: items.map((item) => ({
        companyId: item.companyId ?? null,
        companyName: item.companyId ? null : (item.companyName ?? null),
        title: item.title,
        sourceUrl: item.sourceUrl ?? null,
        rawContent: item.rawContent ?? null,
        ...roleAttrColumns(item),
      })),
      select: { id: true, title: true },
    });
    assertAligned(
      jobs.map((j) => j.title),
      items.map((i) => i.title),
      "job",
    );

    const jobInteractions = await tx.jobInteraction.createManyAndReturn({
      data: jobs.map((job, i) => ({
        userId,
        jobId: job.id,
        status: items[i].opportunityId
          ? JobInteractionStatus.PITCHED
          : JobInteractionStatus.NEW,
        opportunityId: items[i].opportunityId,
      })),
      select: { id: true },
    });

    // Scan-flow / referral roles get a SURFACED seed event; pitched lead roles
    // don't (they enter via the lead, not a board surfacing).
    const seedEvents = jobInteractions
      .filter((_, i) => !items[i].opportunityId)
      .map((ji) => ({
        jobInteractionId: ji.id,
        type: JobEventType.SURFACED,
        occurredAt: now,
        source: EventSource.CHAT_EXTRACTED,
      }));
    if (seedEvents.length > 0) {
      await tx.jobEvent.createMany({ data: seedEvents });
    }

    return jobs.map((job, i) => ({
      jobId: job.id,
      slug: null as string | null,
      title: job.title,
      companyLabel: items[i].companyName ?? "(no company yet)",
      isPitched: !!items[i].opportunityId,
      opportunityId: items[i].opportunityId,
    }));
  });

  // Mint slugs AFTER the transaction commits — the mint retries on
  // unique-collision, which would abort an enclosing transaction. Independent
  // per job, so they mint concurrently. Aligned with `items` by index.
  //
  // Deliberately one write per row rather than a single bulk update: the mint
  // resolves collisions by ATTEMPTING the write and catching the unique
  // violation, because pre-checking with a read races two concurrent minters
  // onto the same slug. Batching would mean pre-checking. Bounded and concurrent
  // (a create batch is a handful of rows), so it stays.
  const slugs = await Promise.all(
    created.map((c, i) =>
      mintJobSlug(c.jobId, {
        companySlug: items[i].companySlug,
        companyName: items[i].companyName,
        title: items[i].title,
        location: items[i].location ?? null,
        department: items[i].department ?? null,
      }),
    ),
  );
  created.forEach((c, i) => (c.slug = slugs[i]));

  return created;
}
