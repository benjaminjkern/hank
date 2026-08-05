// The next-company picker's read model: which companies / jobs / opportunities
// surface in which section, and the subtitle each row reads.
//
// Pure computation — no state mutation, no LLM, no widget. Nothing here commits
// to a choice on the user's behalf: auto-picking the next entity would burn a
// status transition the user had no agency over. The user picks (or hits the
// empty-add CTA) and the widget-submission dispatcher applies focus + status
// transitions then.
//
// The rung-0 profile gate that runs BEFORE this is a procedure — it costs an
// LLM call — and lives in procedures/registry/whatsNext.ts.

import {
  CompanyPauseReason,
  CompanyStatus,
  JobInteractionStatus,
  OpportunityStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { OWED_JOB_STATUSES } from "@/server/entities/jobs/attention";
import { nowDate, nowMs } from "@/utils/now";

// Per-row shape rendered in the widget. Subtitles are activity-based — what
// the user would be DOING if they pick this row — not status labels. See the
// design pinned in this PR for the exact templates.
export type NextOptionRow =
  | {
      kind: "company";
      id: string;
      name: string;
      // logoUrl = Company.logoUrl override; sourceUrl = Company.sourceUrl for
      // the favicon derivation fallback. Either may be null — widget uses
      // companyLogoUrl(sourceUrl, logoUrl) and falls back to a monogram chip
      // on image-load error.
      logoUrl: string | null;
      sourceUrl: string | null;
      subtitle: string;
      status: CompanyStatus;
    }
  | {
      kind: "opportunity";
      id: string;
      label: string;
      subtitle: string;
      status: OpportunityStatus;
    }
  // A specific JOB that's immediate on its own — an interview debrief / offer
  // the user owes a move on (OWED_JOB_STATUSES), or a job-level deferral that
  // has come due. These surface independently of their parent company's status
  // (the whole point: a debrief at a CAUGHT_UP company would otherwise be
  // invisible). Picking one opens the job and drops into the default flow so
  // Hank can run the debrief / offer / un-pause conversation directly.
  | {
      kind: "job";
      id: string; // jobId
      title: string;
      // The parent company's display name when known (real Company), else the
      // freeform Job.companyName, else null for a truly unaffiliated job.
      companyName: string | null;
      logoUrl: string | null;
      sourceUrl: string | null;
      subtitle: string;
      status: JobInteractionStatus;
    };

export type NextOptionSections = {
  // APPLYING companies + OPEN opportunities. Order: least-recent activity first.
  immediate: NextOptionRow[];
  // PAUSED companies — set-aside-but-revivable. Order: least-recent
  // lastDiscussedAt first. Sits between immediate and backlog so paused-with-a-
  // reason rows are easier to revive than buried in the long NEW tail. Picking
  // one revives it (→ APPLYING, pause fields cleared) in the picker-submission
  // dispatcher. (Section key stays `deferred` for wire stability; the user-
  // facing widget title is "Paused".)
  deferred: NextOptionRow[];
  // READY first, then NEW. Order within each: least-recent lastDiscussedAt
  // first. Widget caps at 10 visible + "Show more" expander.
  backlog: NextOptionRow[];
};

const MAX_IMMEDIATE = 50;
const MAX_DEFERRED = 50;
const MAX_BACKLOG = 50;

// A WAITING_ON_RESPONSE job (interview debriefed, ball in the company's court)
// deliberately drops out of "what's next" so Hank stops nagging — but it
// shouldn't vanish forever. Once it's been this quiet (no new event), it
// resurfaces once as a gentle "want to follow up?" nudge. A logged nudge (or any
// event) resets the clock, since it moves the latest event forward.
const STALE_WAITING_DAYS = 14;
const MS_PER_DAY = 86_400_000;

// The rung-0 profile gate is pure INFORMATION — it persists nothing. Profile
// intake isn't a stored mode: the chat runner re-derives it every turn from the
// same memory slots this gate reads, and the caller threads the gaps through.

// Everything actionable RIGHT NOW, single-sourced so it matches the dashboard
// "Now" bucket (both derive owed-ness from @/server/entities/jobs/attention). Two
// urgency tiers, tier 0 first so the picker's confirm-card default
// (immediate[0]) lands on the most pressing thing:
//
//   tier 0 — just-became-actionable: a job the user owes a move on (interview
//            debrief / offer, regardless of company status), an opportunity
//            whose scheduled next step is due.
//   tier 1 — ongoing work: APPLYING companies + OPEN opportunities, most-stale
//            first.
//
// No due-date resurfacing: paused companies / deferred jobs carry no revisit
// timer, so they never auto-promote into the Immediate section — they stay
// parked (paused companies in loadPaused; deferred jobs in the company's
// next-job picker) until explicitly revived.
async function loadImmediate(userId: string): Promise<NextOptionRow[]> {
  const now = nowDate();
  const [active, openOpps, owedJobs, dueOpps, waitingJobs] = await Promise.all([
    prisma.companyInteraction.findMany({
      where: { userId, status: CompanyStatus.APPLYING },
      orderBy: { lastDiscussedAt: { sort: "asc", nulls: "first" } },
      take: MAX_IMMEDIATE,
      select: {
        companyId: true,
        status: true,
        lastDiscussedAt: true,
        company: { select: { name: true, logoUrl: true, sourceUrl: true } },
      },
    }),
    prisma.opportunity.findMany({
      where: { userId, status: OpportunityStatus.OPEN },
      orderBy: { updatedAt: "asc" },
      take: MAX_IMMEDIATE,
      select: { id: true, label: true, status: true, updatedAt: true },
    }),
    // Jobs the user personally owes the next move on — interview debrief / offer
    // decision — at ANY company status. These are what strand at CAUGHT_UP /
    // PAUSED companies the company-status buckets never surface.
    prisma.jobInteraction.findMany({
      where: { userId, status: { in: OWED_JOB_STATUSES } },
      orderBy: { updatedAt: "asc" },
      take: MAX_IMMEDIATE,
      select: {
        jobId: true,
        status: true,
        updatedAt: true,
        job: {
          select: {
            title: true,
            companyName: true,
            company: { select: { name: true, logoUrl: true, sourceUrl: true } },
          },
        },
      },
    }),
    // Opportunities with a scheduled next step that's come due (the lead is
    // OPEN-with-no-date when nextStepAt is null, already covered above).
    prisma.opportunity.findMany({
      where: {
        userId,
        status: {
          in: [OpportunityStatus.SCREENING, OpportunityStatus.AWAITING],
        },
        nextStepAt: { lte: now },
      },
      orderBy: { nextStepAt: "asc" },
      take: MAX_IMMEDIATE,
      select: { id: true, label: true, status: true, nextStepAt: true },
    }),
    // Interview-debriefed jobs parked as WAITING_ON_RESPONSE. These are NOT owed
    // (they intentionally left the picker) — we pull them here only to resurface
    // the ones that have gone quiet past STALE_WAITING_DAYS, gated in JS on the
    // latest event's occurredAt (the "waiting since" clock; a nudge resets it).
    prisma.jobInteraction.findMany({
      where: { userId, status: JobInteractionStatus.WAITING_ON_RESPONSE },
      take: MAX_IMMEDIATE,
      select: {
        jobId: true,
        status: true,
        job: {
          select: {
            title: true,
            companyName: true,
            company: { select: { name: true, logoUrl: true, sourceUrl: true } },
          },
        },
        events: {
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: { occurredAt: true },
        },
      },
    }),
  ]);

  const companyIds = active.map((c) => c.companyId);
  const subtitles = await buildActiveCompanySubtitles(userId, companyIds);

  type Entry = { row: NextOptionRow; tier: 0 | 1 | 2; sortKey: number };
  const entries: Entry[] = [];

  // tier 0 — owed jobs
  for (const j of owedJobs) {
    entries.push({
      row: {
        kind: "job",
        id: j.jobId,
        title: j.job.title,
        companyName: j.job.company?.name ?? j.job.companyName,
        logoUrl: j.job.company?.logoUrl ?? null,
        sourceUrl: j.job.company?.sourceUrl ?? null,
        subtitle: owedJobSubtitle(j.status),
        status: j.status,
      },
      tier: 0,
      sortKey: j.updatedAt.getTime(),
    });
  }
  // tier 0 — opportunities with a due next step
  for (const o of dueOpps) {
    entries.push({
      row: {
        kind: "opportunity",
        id: o.id,
        label: o.label,
        subtitle: "Next step is due",
        status: o.status,
      },
      tier: 0,
      sortKey: o.nextStepAt?.getTime() ?? 0,
    });
  }
  // tier 1 — APPLYING companies
  for (const c of active) {
    entries.push({
      row: {
        kind: "company",
        id: c.companyId,
        name: c.company.name,
        logoUrl: c.company.logoUrl,
        sourceUrl: c.company.sourceUrl,
        subtitle: subtitles.get(c.companyId) ?? "Walking through",
        status: c.status,
      },
      tier: 1,
      sortKey: c.lastDiscussedAt?.getTime() ?? 0,
    });
  }
  // tier 1 — OPEN opportunities
  for (const o of openOpps) {
    entries.push({
      row: {
        kind: "opportunity",
        id: o.id,
        label: o.label,
        subtitle: opportunitySubtitle(o.updatedAt),
        status: o.status,
      },
      tier: 1,
      sortKey: o.updatedAt.getTime(),
    });
  }
  // tier 2 — WAITING_ON_RESPONSE jobs that have gone quiet past the threshold.
  // Gentlest tier (below ongoing work): a "been a while, want to nudge them?"
  // resurface. Fresh ones (event within STALE_WAITING_DAYS) stay silent.
  const staleBefore = now.getTime() - STALE_WAITING_DAYS * MS_PER_DAY;
  for (const j of waitingJobs) {
    const lastAt = j.events[0]?.occurredAt.getTime() ?? 0;
    if (lastAt > staleBefore) continue; // still fresh — keep quiet
    const days = Math.floor((now.getTime() - lastAt) / MS_PER_DAY);
    entries.push({
      row: {
        kind: "job",
        id: j.jobId,
        title: j.job.title,
        companyName: j.job.company?.name ?? j.job.companyName,
        logoUrl: j.job.company?.logoUrl ?? null,
        sourceUrl: j.job.company?.sourceUrl ?? null,
        subtitle: staleWaitingSubtitle(days),
        status: j.status,
      },
      tier: 2,
      sortKey: lastAt,
    });
  }

  return entries
    .sort((a, b) => a.tier - b.tier || a.sortKey - b.sortKey)
    .slice(0, MAX_IMMEDIATE)
    .map((entry) => entry.row);
}

// Plain-English subtitle for an owed job row (no enum leak). Mirrors the
// dashboard's "Now" treatment of these statuses.
function owedJobSubtitle(status: JobInteractionStatus): string {
  switch (status) {
    case JobInteractionStatus.INTERVIEW_DEBRIEF:
      return "Interview wrapped — how'd it go?";
    case JobInteractionStatus.OFFERED:
      return "Offer on the table — time to decide";
    default:
      return "Needs your attention";
  }
}

// Subtitle for a stale WAITING_ON_RESPONSE job resurfacing as a follow-up nudge.
// Weeks read cleaner than a big day count once it's been a while.
function staleWaitingSubtitle(days: number): string {
  const weeks = Math.floor(days / 7);
  const span =
    weeks >= 2
      ? `${weeks} weeks`
      : weeks === 1
        ? "over a week"
        : `${days} days`;
  return `Quiet for ${span} since the interview — want to follow up?`;
}

// PAUSED companies — set aside with a structured reason (no revisit timer).
// Surfaced as their own picker section above the backlog so the user can revive
// one directly. Least-recent lastDiscussedAt first. (Section key stays
// `deferred` on the wire; the widget renders it under a "Paused" title.)
async function loadPaused(userId: string): Promise<NextOptionRow[]> {
  const paused = await prisma.companyInteraction.findMany({
    where: { userId, status: CompanyStatus.PAUSED },
    orderBy: { lastDiscussedAt: { sort: "asc", nulls: "first" } },
    take: MAX_DEFERRED,
    select: {
      companyId: true,
      status: true,
      pauseReason: true,
      company: { select: { name: true, logoUrl: true, sourceUrl: true } },
    },
  });

  return paused.map((c) => ({
    kind: "company",
    id: c.companyId,
    name: c.company.name,
    logoUrl: c.company.logoUrl,
    sourceUrl: c.company.sourceUrl,
    subtitle: pausedCompanySubtitle(c.pauseReason),
    status: c.status,
  }));
}

// "Paused — you set this aside". Plain English — no enum names leak (the user
// never sees CompanyPauseReason).
function pausedCompanySubtitle(reason: CompanyPauseReason | null): string {
  switch (reason) {
    case CompanyPauseReason.USER_PAUSED:
      return "Paused — you set this aside";
    default:
      return "Paused";
  }
}

// READY companies first, then NEW. Within each bucket, least-recent
// lastDiscussedAt first (matching today's rung-3 ordering).
async function loadBacklog(userId: string): Promise<NextOptionRow[]> {
  const [ready, brandNew] = await Promise.all([
    prisma.companyInteraction.findMany({
      where: { userId, status: CompanyStatus.READY },
      orderBy: { lastDiscussedAt: { sort: "asc", nulls: "first" } },
      take: MAX_BACKLOG,
      select: {
        companyId: true,
        status: true,
        lastScrapedJobsAt: true,
        company: {
          select: {
            name: true,
            logoUrl: true,
            sourceUrl: true,
            _count: { select: { jobs: true } },
          },
        },
      },
    }),
    prisma.companyInteraction.findMany({
      where: { userId, status: CompanyStatus.NEW },
      orderBy: { lastDiscussedAt: { sort: "asc", nulls: "first" } },
      take: MAX_BACKLOG,
      select: {
        companyId: true,
        status: true,
        lastScrapedJobsAt: true,
        company: {
          select: {
            name: true,
            logoUrl: true,
            sourceUrl: true,
            _count: { select: { jobs: true } },
          },
        },
      },
    }),
  ]);

  const readyIds = ready.map((c) => c.companyId);
  const readySubtitles = await buildReadyCompanySubtitles(userId, readyIds);

  // Pre-emptive signal: a stub Company that's never been successfully
  // scraped and has zero Job rows on file. The picker calls these out
  // BEFORE the user clicks so picking the row isn't a surprise — and so
  // the user knows the walkthrough is going to run the prep step
  // automatically (step 0 in runCompanyArm).
  const needsScrape = (
    lastScrapedJobsAt: Date | null,
    jobCount: number,
  ): boolean => lastScrapedJobsAt == null && jobCount === 0;

  const readyRows: NextOptionRow[] = ready.map((c) => {
    const subtitle = needsScrape(c.lastScrapedJobsAt, c.company._count.jobs)
      ? "Needs a re-scrape"
      : (readySubtitles.get(c.companyId) ?? "Ready to walk through");
    return {
      kind: "company",
      id: c.companyId,
      name: c.company.name,
      logoUrl: c.company.logoUrl,
      sourceUrl: c.company.sourceUrl,
      subtitle,
      status: c.status,
    };
  });

  const newRows: NextOptionRow[] = brandNew.map((c) => {
    const subtitle = needsScrape(c.lastScrapedJobsAt, c.company._count.jobs)
      ? "Needs scraping — let me try"
      : "Just added";
    return {
      kind: "company",
      id: c.companyId,
      name: c.company.name,
      logoUrl: c.company.logoUrl,
      sourceUrl: c.company.sourceUrl,
      subtitle,
      status: c.status,
    };
  });

  return [...readyRows, ...newRows].slice(0, MAX_BACKLOG);
}

// "5 jobs shortlisted" if any SHORTLISTED at this company.
// Else "12 jobs to shortlist" if SCANNED jobs await.
// Else "Walking through" fallback (e.g. all jobs already CLOSED/DEFERRED).
//
// JobInteraction has no direct companyId — Job is the parent — so we join
// through the `job` relation and aggregate in JS. With ≤50 immediate
// companies the result set is small (a couple-hundred rows max), so a
// single findMany beats two groupBys + a relation join.
async function buildActiveCompanySubtitles(
  userId: string,
  companyIds: string[],
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map();
  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId,
      job: { companyId: { in: companyIds } },
      status: {
        in: [JobInteractionStatus.SHORTLISTED, JobInteractionStatus.SCANNED],
      },
    },
    select: {
      status: true,
      job: { select: { companyId: true } },
    },
  });
  const byCompany = new Map<string, { shortlisted: number; scanned: number }>();
  for (const id of companyIds)
    byCompany.set(id, { shortlisted: 0, scanned: 0 });
  for (const r of rows) {
    const cid = r.job.companyId;
    if (!cid) continue;
    const slot = byCompany.get(cid);
    if (!slot) continue;
    if (r.status === JobInteractionStatus.SHORTLISTED) slot.shortlisted += 1;
    if (r.status === JobInteractionStatus.SCANNED) slot.scanned += 1;
  }
  const out = new Map<string, string>();
  for (const [id, s] of byCompany) {
    if (s.shortlisted > 0) {
      out.set(
        id,
        `${s.shortlisted} job${s.shortlisted === 1 ? "" : "s"} shortlisted`,
      );
    } else if (s.scanned > 0) {
      out.set(id, `${s.scanned} job${s.scanned === 1 ? "" : "s"} to shortlist`);
    } else {
      out.set(id, "Walking through");
    }
  }
  return out;
}

// "12 jobs to walk through" — counts SCANNED jobs (the PRE_SCAN survivors).
async function buildReadyCompanySubtitles(
  userId: string,
  companyIds: string[],
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map();
  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId,
      job: { companyId: { in: companyIds } },
      status: JobInteractionStatus.SCANNED,
    },
    select: { job: { select: { companyId: true } } },
  });
  const byCompany = new Map<string, number>();
  for (const r of rows) {
    const cid = r.job.companyId;
    if (!cid) continue;
    byCompany.set(cid, (byCompany.get(cid) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [id, n] of byCompany) {
    out.set(id, `${n} job${n === 1 ? "" : "s"} to walk through`);
  }
  return out;
}

// "Reached out today" / "Reached out yesterday" / "Reached out N days ago".
// updatedAt advances on any status/contact/event change — good proxy for
// "when did we last touch this thread."
function opportunitySubtitle(updatedAt: Date): string {
  const ageMs = nowMs() - updatedAt.getTime();
  const days = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Reached out today";
  if (days === 1) return "Reached out yesterday";
  return `Reached out ${days} days ago`;
}

// The three section loads. No profile gate, no session mutation — the gate is
// rung 0 of procedures/registry/whatsNext.ts, and `show_whats_next` skips it on
// purpose (it's only offered mid-flow, where the profile is already past it).
export async function computeWhatsNextOptions(
  userId: string,
): Promise<{ options: NextOptionSections; empty: boolean }> {
  const [immediate, deferred, backlog] = await Promise.all([
    loadImmediate(userId),
    loadPaused(userId),
    loadBacklog(userId),
  ]);
  const empty =
    immediate.length === 0 && deferred.length === 0 && backlog.length === 0;
  return { options: { immediate, deferred, backlog }, empty };
}
