import {
  CompanyStatus,
  JobEventType,
  JobInteractionStatus,
  OpportunityStatus,
  type CompanyPauseReason,
  type CompanyCloseReason,
  type CompanyBlockReason,
} from "@/generated/prisma/client";
import { companyLogoUrl } from "@/lib/companyLogo";
import { resolveViewedUser } from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import { flipDueInterviewsToDebrief } from "@/server/entities/jobs/flipDueInterviews";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";

export const dynamic = "force-dynamic";

// Active = SCANNED (Hank has read it, awaiting shortlist approval) or
// SHORTLISTED or further (committed to applying). NEW is too noisy (every
// scrape creates NEW rows); CLOSED is the explicit dismissal. Drill into a
// company's page for the full NEW/CLOSED list, bucketed into pipeline vs.
// other.
const ACTIVE = [
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.APPLYING,
  JobInteractionStatus.APPLIED,
  JobInteractionStatus.RESPONDED,
  JobInteractionStatus.INTERVIEW_SCHEDULED,
  JobInteractionStatus.INTERVIEW_DEBRIEF,
  JobInteractionStatus.WAITING_ON_RESPONSE,
  JobInteractionStatus.OFFERED,
  // REJECTED intentionally excluded — closed jobs roll off the dashboard
  // summary (they remain visible on the company detail page's job groups).
];

// Sort buckets for the non-closed, non-paused, non-blocked list: SHORTLISTING
// first (the board is open and it is the user's move), then APPLYING
// (shortlist committed, roles being worked), then IN_PROCESS (employer engaged) / IN_FLIGHT
// (apps out) — the live-pipeline tail — then READY (scanned, waiting on the
// user), NEW (no scan yet), CAUGHT_UP (resting). CLOSED + PAUSED + BLOCKED are
// split into their own lists below.
const STATUS_RANK: Record<
  Exclude<CompanyStatus, "CLOSED" | "PAUSED" | "BLOCKED">,
  number
> = {
  SHORTLISTING: 0,
  APPLYING: 1,
  IN_PROCESS: 2,
  IN_FLIGHT: 3,
  SCANNING: 4,
  READY: 5,
  NEW: 6,
  CAUGHT_UP: 7,
};

// Opportunities the dashboard surfaces by default (OPEN / SCREENING / AWAITING).
// CLOSED leads roll off — they're dead trails.
const ACTIVE_OPPORTUNITY = [
  OpportunityStatus.OPEN,
  OpportunityStatus.SCREENING,
  OpportunityStatus.AWAITING,
];

// Rank by status so the dashboard puts open leads (no call yet) at the top,
// then anything scheduled, then anything waiting on the other side.
const OPP_STATUS_RANK: Record<(typeof ACTIVE_OPPORTUNITY)[number], number> = {
  OPEN: 0,
  SCREENING: 1,
  AWAITING: 2,
};

type DashboardCompany = {
  companyId: string;
  companyName: string;
  // Resolved logo URL, override or auto-derived. Mirrors the client
  // DashboardCompany type — keep in sync.
  logoUrl: string;
  status: Exclude<CompanyStatus, "CLOSED" | "PAUSED" | "BLOCKED">;
  // ISO timestamp of the most recent successful scrape, or null if the
  // company has never been scanned. Drives the empty-row label.
  lastScrapedJobsAt: string | null;
  // Count of jobs whose lastSeenAt matches lastScrapedJobsAt — i.e. jobs that
  // were on the careers page at the most recent scan. Excludes stale rows
  // from prior scans that have since fallen off. Zero when never scanned.
  recentJobCount: number;
  jobInteractions: Array<{
    jobInteractionId: string;
    jobId: string;
    title: string;
    sourceUrl: string | null;
    status: JobInteractionStatus;
    location: string | null;
    compensation: string | null;
    department: string | null;
    employmentType: string | null;
    lastEventType: string | null;
    lastEventAt: string | null;
    // When the user applied, for APPLIED jobs aging without a response (drives
    // the escalating pill color + "Applied …" caption). Derived from the latest
    // event when it's the APPLIED event — which it is for a job still sitting in
    // APPLIED, since a reply would have moved it to RESPONDED. Null otherwise.
    appliedAt: string | null;
  }>;
};

type DashboardClosedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  closeReason: CompanyCloseReason | null;
  closeNote: string | null;
};

type DashboardPausedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  pauseReason: CompanyPauseReason | null;
  pauseNote: string | null;
};

// Companies set aside because their board couldn't be read (BLOCKED). A
// technical set-aside, NOT a fit judgment — revivable (revive re-hunts). Its
// own dashboard list so the client renders a distinct "Blocked" bucket rather
// than lumping it with closed (red) or the active companies.
type DashboardBlockedCompany = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  blockReason: CompanyBlockReason | null;
  blockNote: string | null;
};

type DashboardOpportunityJob = {
  jobInteractionId: string;
  jobId: string;
  title: string;
  status: JobInteractionStatus; // includes PITCHED for opportunity-linked rows
  // Whichever is non-null: the joined Company.name (when linked to a real
  // Company) or the freeform Job.companyName the agent captured for an
  // unaffiliated pitch. UI consumers render whichever is set; null means we
  // genuinely don't know the company.
  companyDisplayName: string | null;
  companyId: string | null;
  // logoUrl is set when companyId is — drives the same logo chip used in the
  // main Company groups. Null for unaffiliated pitched jobs.
  logoUrl: string | null;
  // Application date for an APPLIED pitched role aging without a response
  // (drives the escalating pill color + "Applied …" caption); null otherwise.
  appliedAt: string | null;
};

type DashboardOpportunity = {
  opportunityId: string;
  label: string;
  status: (typeof ACTIVE_OPPORTUNITY)[number];
  nextStepAt: string | null;
  primaryContact: { name: string; agency: string | null } | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  // The pitched/discussed roles inside this lead — regular JobInteractions
  // linked via JobInteraction.opportunityId. Each row clicks into the normal
  // JobDetailView via viewJob(jobId).
  jobs: DashboardOpportunityJob[];
};

export async function GET(req: Request) {
  const { viewedUserId } = await resolveViewedUser(req);
  // Read the *viewed* user's admin status — when an admin views a non-admin's
  // session we want to show the dashboard as the non-admin would see it
  // (no admin tiles, no admin counts), not echo the caller's admin powers.
  const viewedUser = await prisma.user.findUnique({
    where: { id: viewedUserId },
    select: { isAdmin: true },
  });
  const isAdmin = viewedUser?.isAdmin ?? false;

  // Lazy promote INTERVIEW_SCHEDULED → INTERVIEW_DEBRIEF for rows whose
  // interview date has passed, so the dashboard reflects "user owes a
  // debrief" without a background cron. See flipDueInterviews.ts.
  await flipDueInterviewsToDebrief();

  const [rows, opportunityRows, openAdminNoteCount, openDeletionRecCount] =
    await Promise.all([
      prisma.companyInteraction.findMany({
        where: { userId: viewedUserId },
        include: {
          company: {
            select: {
              id: true,
              name: true,
              sourceUrl: true,
              logoUrl: true,
              jobs: {
                select: {
                  id: true,
                  title: true,
                  sourceUrl: true,
                  ...ROLE_ATTR_SELECT,
                  lastSeenAt: true,
                  jobInteractions: {
                    where: { userId: viewedUserId, status: { in: ACTIVE } },
                    select: {
                      id: true,
                      status: true,
                      updatedAt: true,
                      events: {
                        orderBy: { occurredAt: "desc" },
                        take: 1,
                        select: { type: true, occurredAt: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.opportunity.findMany({
        where: { userId: viewedUserId, status: { in: ACTIVE_OPPORTUNITY } },
        select: {
          id: true,
          label: true,
          status: true,
          nextStepAt: true,
          primaryContact: { select: { name: true, agency: true } },
          events: {
            orderBy: { occurredAt: "desc" },
            take: 1,
            select: { type: true, occurredAt: true },
          },
          jobInteractions: {
            // Hide closed/rejected rows from the dashboard inline list — they
            // live in the opportunity-detail page's "Show closed" toggle
            // section instead, mirroring how the Company groups bucket their
            // closed jobs. Keeps the dashboard surface focused on live work.
            where: {
              status: {
                notIn: [
                  JobInteractionStatus.CLOSED,
                  JobInteractionStatus.REJECTED,
                ],
              },
            },
            orderBy: [{ status: "asc" }, { createdAt: "asc" }],
            select: {
              id: true,
              status: true,
              job: {
                select: {
                  id: true,
                  title: true,
                  companyId: true,
                  companyName: true,
                  closedAt: true,
                  company: {
                    select: { name: true, sourceUrl: true, logoUrl: true },
                  },
                },
              },
            },
          },
        },
      }),
      isAdmin
        ? prisma.adminNote.count({
            where: { userId: viewedUserId, dismissed: false },
          })
        : Promise.resolve(0),
      isAdmin
        ? Promise.all([
            prisma.company.count({
              where: { deletionRecommendedAt: { not: null } },
            }),
            prisma.job.count({
              where: { deletionRecommendedAt: { not: null } },
            }),
          ]).then(([c, j]) => c + j)
        : Promise.resolve(0),
    ]);

  // Latest APPLIED-event date per still-applied JobInteraction (company + lead
  // roles alike). Done as one grouped query rather than reading each
  // JobInteraction's most-recent event, because the APPLIED event is usually NOT
  // the latest: a DRAFT_USED logged after applying, or a backdated application,
  // pushes it down the list (empirically ~73% of applied rows). groupBy + _max
  // finds it regardless of how many other events sit on top.
  const appliedEventRows = await prisma.jobEvent.groupBy({
    by: ["jobInteractionId"],
    where: {
      type: JobEventType.APPLIED,
      jobInteraction: {
        userId: viewedUserId,
        status: JobInteractionStatus.APPLIED,
      },
    },
    _max: { occurredAt: true },
  });
  const appliedAtByJobInteraction = new Map<string, string>(
    appliedEventRows
      .filter((r) => r._max.occurredAt)
      .map((r) => [r.jobInteractionId, r._max.occurredAt!.toISOString()]),
  );

  const companies: DashboardCompany[] = [];
  const closed: DashboardClosedCompany[] = [];
  const paused: DashboardPausedCompany[] = [];
  const blocked: DashboardBlockedCompany[] = [];

  for (const r of rows) {
    const logoUrl = companyLogoUrl(r.company.sourceUrl, r.company.logoUrl);
    if (r.status === CompanyStatus.CLOSED) {
      closed.push({
        companyId: r.company.id,
        companyName: r.company.name,
        logoUrl,
        closeReason: r.closeReason,
        closeNote: r.closeNote,
      });
      continue;
    }
    if (r.status === CompanyStatus.BLOCKED) {
      blocked.push({
        companyId: r.company.id,
        companyName: r.company.name,
        logoUrl,
        blockReason: r.blockReason,
        blockNote: r.blockNote,
      });
      continue;
    }
    if (r.status === CompanyStatus.PAUSED) {
      paused.push({
        companyId: r.company.id,
        companyName: r.company.name,
        logoUrl,
        pauseReason: r.pauseReason,
        pauseNote: r.pauseNote,
      });
      continue;
    }

    const jobInteractions: DashboardCompany["jobInteractions"] = [];
    for (const job of r.company.jobs) {
      for (const i of job.jobInteractions) {
        const last = i.events[0];
        const lastAt = last?.occurredAt.toISOString() ?? null;
        jobInteractions.push({
          jobInteractionId: i.id,
          jobId: job.id,
          title: job.title,
          sourceUrl: job.sourceUrl,
          status: i.status,
          ...toRoleAttrs(job),
          lastEventType: last?.type ?? null,
          lastEventAt: lastAt,
          appliedAt: appliedAtByJobInteraction.get(i.id) ?? null,
        });
      }
    }
    // Most-recent activity first within a company.
    jobInteractions.sort((a, b) =>
      (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""),
    );

    // Count jobs that were present at the most recent scan. A job is part
    // of "this scan" if its lastSeenAt is at least lastScrapedJobsAt — they're
    // stamped from the same timestamp in the scan.
    const scrapeCutoff = r.lastScrapedJobsAt?.getTime() ?? null;
    const recentJobCount =
      scrapeCutoff === null
        ? 0
        : r.company.jobs.filter(
            (j) => j.lastSeenAt && j.lastSeenAt.getTime() >= scrapeCutoff,
          ).length;

    companies.push({
      companyId: r.company.id,
      companyName: r.company.name,
      logoUrl,
      status: r.status,
      lastScrapedJobsAt: r.lastScrapedJobsAt?.toISOString() ?? null,
      recentJobCount,
      jobInteractions,
    });
  }

  companies.sort((a, b) => {
    const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rankDiff !== 0) return rankDiff;
    const aLatest = a.jobInteractions[0]?.lastEventAt ?? "";
    const bLatest = b.jobInteractions[0]?.lastEventAt ?? "";
    return (
      bLatest.localeCompare(aLatest) ||
      a.companyName.localeCompare(b.companyName)
    );
  });

  closed.sort((a, b) => a.companyName.localeCompare(b.companyName));
  blocked.sort((a, b) => a.companyName.localeCompare(b.companyName));
  // Paused companies have no revisit timer anymore — sort by name.
  paused.sort((a, b) => a.companyName.localeCompare(b.companyName));

  const opportunities: DashboardOpportunity[] = opportunityRows.map((o) => {
    const last = o.events[0];
    return {
      opportunityId: o.id,
      label: o.label,
      status: o.status as (typeof ACTIVE_OPPORTUNITY)[number],
      nextStepAt: o.nextStepAt?.toISOString() ?? null,
      primaryContact: o.primaryContact
        ? { name: o.primaryContact.name, agency: o.primaryContact.agency }
        : null,
      lastEventType: last?.type ?? null,
      lastEventAt: last?.occurredAt.toISOString() ?? null,
      jobs: o.jobInteractions.map((ji) => ({
        jobInteractionId: ji.id,
        jobId: ji.job.id,
        title: ji.job.title,
        status: ji.status,
        companyDisplayName: ji.job.company?.name ?? ji.job.companyName,
        companyId: ji.job.companyId,
        logoUrl: ji.job.company
          ? companyLogoUrl(ji.job.company.sourceUrl, ji.job.company.logoUrl)
          : null,
        appliedAt: appliedAtByJobInteraction.get(ji.id) ?? null,
        // CLOSED/REJECTED roles are filtered off the dashboard above, so the
        // only terminal status that reaches a lead row is DELISTED, which dates
        // off Job.closedAt — the global takedown date, and the authority.
        closedAt:
          ji.status === JobInteractionStatus.DELISTED
            ? (ji.job.closedAt?.toISOString() ?? null)
            : null,
      })),
    };
  });

  // Sort: status bucket first (OPEN → SCREENING → AWAITING), then by the
  // upcoming nextStepAt soonest-first (nulls last), then most-recent activity.
  opportunities.sort((a, b) => {
    const rank = OPP_STATUS_RANK[a.status] - OPP_STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    if (a.nextStepAt && b.nextStepAt) {
      const cmp = a.nextStepAt.localeCompare(b.nextStepAt);
      if (cmp !== 0) return cmp;
    } else if (a.nextStepAt) return -1;
    else if (b.nextStepAt) return 1;
    return (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "");
  });

  const total = companies.reduce((acc, c) => acc + c.jobInteractions.length, 0);

  return Response.json({
    companies,
    closed,
    paused,
    blocked,
    opportunities,
    total,
    isAdmin,
    openAdminNoteCount,
    openDeletionRecCount,
  });
}
