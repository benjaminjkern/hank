// Company "engagement tail" — the auto-derived portion of the CompanyStatus
// lifecycle. Once a walkthrough wraps, a company's status is a pure function of
// its jobs' pipeline states:
//
//   IN_PROCESS  — an employer has engaged (a live job in RESPONDED /
//                 INTERVIEW_SCHEDULED / INTERVIEW_DEBRIEF / WAITING_ON_RESPONSE /
//                 OFFERED)
//   IN_FLIGHT   — >=1 application submitted and still live (a job in APPLIED),
//                 nobody's replied yet
//   CAUGHT_UP   — nothing live; scanned + worked through, watching for new roles
//
// Precedence is IN_PROCESS > IN_FLIGHT > CAUGHT_UP.
//
// The other six statuses (NEW / READY / APPLYING / PAUSED / BLOCKED / CLOSED)
// are MANUALLY HELD: a job event won't auto-move them. A held company re-enters
// the derived tail only when the walkthrough wraps (APPLYING → derived, forced)
// or on a revive. That's why the two entry points differ:
//   * refreshCompanyEngagement — event-driven, NO-OP unless already in the tail.
//   * computeCompanyEngagement  — pure compute the wrap uses to FORCE a tail set.

import { CompanyStatus, JobInteractionStatus } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

type EngagementStatus =
  | typeof CompanyStatus.IN_PROCESS
  | typeof CompanyStatus.IN_FLIGHT
  | typeof CompanyStatus.CAUGHT_UP;

// "An employer has engaged." Any of these at a company => IN_PROCESS.
const ENGAGED_JOB_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.RESPONDED,
  JobInteractionStatus.INTERVIEW_SCHEDULED,
  JobInteractionStatus.INTERVIEW_DEBRIEF,
  JobInteractionStatus.WAITING_ON_RESPONSE, // interviewed, waiting on their call — still a live process
  JobInteractionStatus.OFFERED,
];

// Company statuses that are auto-derived from job pipeline state. A company in
// any OTHER status is manually held and left alone by refreshCompanyEngagement.
const AUTO_MANAGED_COMPANY_STATUSES: CompanyStatus[] = [
  CompanyStatus.IN_FLIGHT,
  CompanyStatus.IN_PROCESS,
  CompanyStatus.CAUGHT_UP,
];

// Pure derivation from a company's JobInteraction statuses.
function deriveCompanyEngagement(
  jobStatuses: JobInteractionStatus[],
): EngagementStatus {
  if (jobStatuses.some((s) => ENGAGED_JOB_STATUSES.includes(s)))
    return CompanyStatus.IN_PROCESS;
  if (jobStatuses.some((s) => s === JobInteractionStatus.APPLIED))
    return CompanyStatus.IN_FLIGHT;
  return CompanyStatus.CAUGHT_UP;
}

// Compute the engagement status for a company by reading its jobs. Used by the
// walkthrough wrap to FORCE a tail state (the company is leaving APPLYING, which
// isn't auto-managed, so refreshCompanyEngagement wouldn't touch it).
export async function computeCompanyEngagement(
  userId: string,
  companyId: string,
  db: Db = prisma,
): Promise<EngagementStatus> {
  const jobs = await db.jobInteraction.findMany({
    where: { userId, job: { companyId } },
    select: { status: true },
  });
  return deriveCompanyEngagement(jobs.map((j) => j.status));
}

// Event-driven refresh: recompute + persist engagement for a set of companies,
// but ONLY for those currently in the auto-managed tail (never overrides a
// manually-held APPLYING / PAUSED / BLOCKED / CLOSED / NEW / READY). Call after
// any job pipeline event lands (log_job_events, mark_job_applied, REJECTED, …).
// A job with no company (agency-pitched, companyId null) has no company to
// refresh. Best-effort: swallows its own errors so it never breaks the event
// write.
//
// Cost is FLAT in the number of companies — two reads and at most three writes,
// because there are only three engagement statuses to move a company to, so the
// updates group by target rather than going out one per company.
export async function refreshCompaniesEngagement(
  userId: string,
  companyIds: Array<string | null | undefined>,
  db: Db = prisma,
): Promise<void> {
  const unique = [...new Set(companyIds.filter((c): c is string => !!c))];
  if (unique.length === 0) return;
  try {
    const managed = await db.companyInteraction.findMany({
      where: {
        userId,
        companyId: { in: unique },
        status: { in: AUTO_MANAGED_COMPANY_STATUSES },
      },
      select: { companyId: true, status: true },
    });
    if (managed.length === 0) return;

    const managedIds = managed.map((c) => c.companyId);
    const jobs = await db.jobInteraction.findMany({
      where: { userId, job: { companyId: { in: managedIds } } },
      select: { status: true, job: { select: { companyId: true } } },
    });
    const statusesByCompany = new Map<string, JobInteractionStatus[]>();
    for (const j of jobs) {
      const companyId = j.job?.companyId;
      if (!companyId) continue;
      const list = statusesByCompany.get(companyId);
      if (list) list.push(j.status);
      else statusesByCompany.set(companyId, [j.status]);
    }

    // companyIds that need to move, grouped by where they're moving TO.
    const movingTo = new Map<EngagementStatus, string[]>();
    for (const ci of managed) {
      const next = deriveCompanyEngagement(
        statusesByCompany.get(ci.companyId) ?? [],
      );
      if (next === ci.status) continue;
      const group = movingTo.get(next);
      if (group) group.push(ci.companyId);
      else movingTo.set(next, [ci.companyId]);
    }

    await Promise.all(
      [...movingTo].map(([status, ids]) =>
        db.companyInteraction.updateMany({
          where: { userId, companyId: { in: ids } },
          data: { status },
        }),
      ),
    );
  } catch {
    // best-effort — engagement is a denormalized cache; a failed refresh just
    // means the next job event (or a panel read) recomputes it.
  }
}

// Single-company convenience. One implementation, so the batch and the singular
// can't drift.
export async function refreshCompanyEngagement(
  userId: string,
  companyId: string,
  db: Db = prisma,
): Promise<void> {
  await refreshCompaniesEngagement(userId, [companyId], db);
}
