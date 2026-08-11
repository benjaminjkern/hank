// The company detail page — the payload the right panel and chat store render,
// plus the loader that builds it.

import { companyLogoUrl } from "@/lib/companyLogo";
import { prisma } from "@/server/db/prisma";
import { flipDueInterviewsToDebrief } from "@/server/entities/jobs/flipDueInterviews";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";
import { CONTACT_SELECT, type ContactView } from "@/server/views/contactView";

export type CompanyJobView = {
  jobId: string;
  jobInteractionId: string;
  title: string;
  sourceUrl: string | null;
  status: string;
  // Populated only when status=CLOSED. Mirrors the dashboard's
  // skipped-companies treatment: show the reason in the row, expose
  // closeNote as a hover tooltip.
  closeReason: string | null;
  closeNote: string | null;
  // Populated only when status=DEFERRED ("could apply, outranked for now").
  deferReason: string | null;
  deferNote: string | null;
  updatedAt: string;
  // Application date for an APPLIED job aging without a response (drives the
  // escalating pill color + "Applied …" caption); null otherwise.
  appliedAt: string | null;
  // When the role ended, for terminal rows: the CLOSED/REJECTED/WITHDRAWN event
  // date, or Job.closedAt for DELISTED (no event). Null for non-terminal rows.
  closedAt: string | null;
};

export type CompanyEventView = {
  id: string;
  type: string;
  occurredAt: string;
  notes: string | null;
  // Set on per-role rows (APPLIED/RESPONDED/…); null on batch-summary + status
  // rows (JOBS_CLOSED/SCRAPE_FOUND/SHORTLIST_RAN/PAUSED/…).
  jobId: string | null;
  jobTitle: string | null;
};

export type CompanyStatusName =
  | "NEW"
  | "READY"
  | "SCANNING"
  | "SHORTLISTING"
  | "APPLYING"
  | "IN_FLIGHT"
  | "IN_PROCESS"
  | "CAUGHT_UP"
  | "PAUSED"
  | "BLOCKED"
  | "CLOSED";
export type CompanyCloseReasonName =
  "NOT_A_MATCH" | "LOCATION_MISMATCH" | "OTHER";
export type CompanyPauseReasonName = "USER_PAUSED" | "OTHER";
export type CompanyBlockReasonName =
  "CANNOT_SCRAPE" | "AMBIGUOUS_NAME" | "NO_OWN_BOARD" | "AUTH_WALLED" | "OTHER";

export type FocusedCompanyView = {
  id: string;
  name: string;
  // The company's URL segment (/dashboard/<slug>). NOT NULL in the schema.
  slug: string;
  // Nullable while the add_to_watchlist URL hunter is still in flight or
  // ended with CANNOT_SCRAPE. UI renders a placeholder when null.
  sourceUrl: string | null;
  description: string | null;
  status: CompanyStatusName;
  closeReason: CompanyCloseReasonName | null;
  closeNote: string | null;
  // Populated when status=PAUSED (set aside for now; revivable).
  pauseReason: CompanyPauseReasonName | null;
  pauseNote: string | null;
  // Populated when status=BLOCKED (couldn't read the board; revivable).
  blockReason: CompanyBlockReasonName | null;
  blockNote: string | null;
  logoUrl: string;
  jobs: CompanyJobView[];
  recentEvents: CompanyEventView[];
  // Total count of non-excluded events at this company (independent of the
  // capped slice in recentEvents). Powers the "Show X more" expansion.
  recentEventsTotal: number;
  memoryNote: string | null;
  // People at this company, via Contact.companyId — recruiters, hiring
  // managers, anyone the user has talked to. Empty for most companies.
  contacts: ContactView[];
  lastActivityAt: string | null;
  lastScrapedJobsAt: string | null;
  // A shortlist proposal is on the table for this company — the only state in
  // which the board screen is worth opening, so the page links to it only then.
  shortlistBoardOpen: boolean;
};

// Cap on events returned for the company timeline. The UI shows a preview
// (~5) with a "Show X more" toggle that expands to the full set returned
// here. 50 is well above the typical company event count in v0; companies
// with more history can extend later.
const RECENT_EVENTS_LIMIT = 50;

// JobEvent types the per-job loader still needs — NOT for the company feed
// (that reads CompanyEvent now), but to date job rows: APPLIED → appliedAt,
// CLOSED/REJECTED/WITHDRAWN → closedAt. Everything else is off the per-job read.
const JOB_DATING_EVENT_TYPES = [
  "APPLIED",
  "CLOSED",
  "REJECTED",
  "WITHDRAWN",
] as const;

// Event types that mark a role ending — used to date a terminal CLOSED/REJECTED
// row (a withdrawal logs a WITHDRAWN event but lands as CLOSED). DELISTED is
// dated off Job.closedAt instead: that's the global takedown date, and the
// authority over the per-user event.
const TERMINAL_EVENT_TYPES = new Set<string>([
  "CLOSED",
  "REJECTED",
  "WITHDRAWN",
]);

export async function getFocusedCompanyView(
  userId: string,
  companyId: string,
): Promise<FocusedCompanyView | null> {
  // Lazy-flip any due interview rows before reading so the company timeline
  // and job-status pills reflect "user owes a debrief" when the interview
  // date has passed.
  await flipDueInterviewsToDebrief();
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      slug: true,
      sourceUrl: true,
      logoUrl: true,
      description: true,
      companyInteractions: {
        where: { userId },
        select: {
          status: true,
          closeReason: true,
          closeNote: true,
          pauseReason: true,
          pauseNote: true,
          blockReason: true,
          blockNote: true,
          lastScrapedJobsAt: true,
        },
        take: 1,
      },
      // Contact is user-scoped even though it hangs off the global Company, so
      // this relation needs its own userId filter.
      contacts: {
        where: { userId },
        orderBy: { name: "asc" },
        select: CONTACT_SELECT,
      },
      jobs: {
        select: {
          id: true,
          title: true,
          sourceUrl: true,
          closedAt: true,
          jobInteractions: {
            where: { userId },
            select: {
              id: true,
              status: true,
              closeReason: true,
              closeNote: true,
              deferReason: true,
              deferNote: true,
              updatedAt: true,
              events: {
                where: { type: { in: [...JOB_DATING_EVENT_TYPES] } },
                orderBy: { occurredAt: "desc" },
                take: RECENT_EVENTS_LIMIT,
                select: {
                  id: true,
                  type: true,
                  occurredAt: true,
                  notes: true,
                },
              },
            },
            take: 1,
          },
        },
      },
    },
  });
  if (!company) return null;

  const jobs = company.jobs
    .filter((j) => j.jobInteractions[0])
    .map((j) => {
      const i = j.jobInteractions[0];
      // Application date for an APPLIED job aging without a response. Events are
      // ordered occurredAt-desc, so the first APPLIED is the latest one. Only
      // meaningful while the job is still in APPLIED (a reply moves it on).
      const appliedAt =
        i.status === "APPLIED"
          ? (i.events
              .find((e) => e.type === "APPLIED")
              ?.occurredAt.toISOString() ?? null)
          : null;
      // When the role ended. DELISTED has no event — the posting-gone date
      // lives on Job.closedAt. CLOSED/REJECTED (incl. withdrawals, which log a
      // WITHDRAWN event) take the latest terminal event's date.
      const closedAt =
        i.status === "DELISTED"
          ? (j.closedAt?.toISOString() ?? null)
          : i.status === "CLOSED" || i.status === "REJECTED"
            ? (i.events
                .find((e) => TERMINAL_EVENT_TYPES.has(e.type))
                ?.occurredAt.toISOString() ?? null)
            : null;
      return {
        jobId: j.id,
        jobInteractionId: i.id,
        title: j.title,
        sourceUrl: j.sourceUrl,
        status: i.status,
        closeReason: i.closeReason ?? null,
        closeNote: i.closeNote ?? null,
        deferReason: i.deferReason ?? null,
        deferNote: i.deferNote ?? null,
        updatedAt: i.updatedAt.toISOString(),
        appliedAt,
        closedAt,
      };
    });

  // The company timeline is now first-class: read the CompanyEvent feed directly
  // (batch summaries + per-role milestones + status changes), not a flatten of
  // every job's JobEvents. jobTitle is a stored snapshot, so no join.
  const recentEvents = (
    await prisma.companyEvent.findMany({
      where: { userId, companyId },
      orderBy: { occurredAt: "desc" },
      take: RECENT_EVENTS_LIMIT,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        notes: true,
        jobId: true,
        jobTitle: true,
      },
    })
  ).map((e) => ({
    id: e.id,
    type: e.type,
    occurredAt: e.occurredAt.toISOString(),
    notes: e.notes,
    jobId: e.jobId,
    jobTitle: e.jobTitle,
  }));

  // Authoritative total (independent of the take-cap) for the "Show X more"
  // toggle.
  const recentEventsTotal = await prisma.companyEvent.count({
    where: { userId, companyId },
  });

  const lastActivityAt = recentEvents[0]?.occurredAt ?? null;

  // Whether a shortlist proposal is on the table — the page links to the board
  // only while there's something to decide there.
  const shortlistBoardOpen =
    (await prisma.jobInteraction.count({
      where: { userId, job: { companyId }, ...onBoardWhere() },
    })) > 0;

  const note = await prisma.memoryNote.findUnique({
    where: { userId_path: { userId, path: `companies/${company.slug}.md` } },
    select: { content: true },
  });

  const companyInteraction = company.companyInteractions[0];

  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    sourceUrl: company.sourceUrl,
    description: company.description,
    status: companyInteraction?.status ?? "NEW",
    closeReason: companyInteraction?.closeReason ?? null,
    closeNote: companyInteraction?.closeNote ?? null,
    pauseReason: companyInteraction?.pauseReason ?? null,
    pauseNote: companyInteraction?.pauseNote ?? null,
    blockReason: companyInteraction?.blockReason ?? null,
    blockNote: companyInteraction?.blockNote ?? null,
    logoUrl: companyLogoUrl(company.sourceUrl, company.logoUrl),
    jobs,
    recentEvents,
    recentEventsTotal,
    memoryNote: note?.content ?? null,
    contacts: company.contacts,
    lastActivityAt,
    lastScrapedJobsAt:
      companyInteraction?.lastScrapedJobsAt?.toISOString() ?? null,
    shortlistBoardOpen,
  };
}
