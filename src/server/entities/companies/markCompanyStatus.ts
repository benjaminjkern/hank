// Direct company-status flips used outside a chat turn — nothing ends here, so
// these are plain CompanyInteraction updates rather than the set-asides in
// setCompanyAside.ts (which report `endedCompanyId` and get narrated). All clear
// every reason field per the clear-on-transition rule, in one place so the
// callers can't drift on the cleared-field set.
//
// Callers are the seams that pull a board in and then have to say where the
// company stands: the watchlist add + the re-scrape both use
// `markCompanyPostFilter` after PRE_SCAN; the walkthrough uses `markCompanyReady`
// directly (it must not land CAUGHT_UP from a metadata pass — its own step 3
// wrap owns the ending, after the body-reads). PRE_SCAN itself writes no status.

import { CompanyStatus, CompanyEventType } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { companyStatusFields } from "@/server/entities/companies/companyStatusFields";
import { logCompanyEvent } from "@/server/entities/companies/logCompanyEvent";

// Statuses these helpers are allowed to overwrite — the pre-walkthrough /
// re-check states. Won't touch APPLYING / IN_FLIGHT / IN_PROCESS / PAUSED (live
// work or a user-driven set-aside) rows.
const OVERWRITABLE = [
  CompanyStatus.NEW,
  CompanyStatus.READY,
  CompanyStatus.CAUGHT_UP,
  CompanyStatus.BLOCKED,
  CompanyStatus.CLOSED,
] as const;

export async function markCompanyReady(
  companyId: string,
  userId: string,
): Promise<void> {
  await prisma.companyInteraction.updateMany({
    where: { userId, companyId, status: { in: [...OVERWRITABLE] } },
    data: companyStatusFields({ status: CompanyStatus.READY }),
  });
}

// No survivors but the company is on-thesis (could post a fit later): mark
// CAUGHT_UP, not CLOSED. Clears all reason fields per clear-on-transition.
async function markCompanyCaughtUp(
  companyId: string,
  userId: string,
): Promise<void> {
  const { count } = await prisma.companyInteraction.updateMany({
    where: { userId, companyId, status: { in: [...OVERWRITABLE] } },
    data: companyStatusFields({ status: CompanyStatus.CAUGHT_UP }),
  });
  // Only emit a company-feed row when the flip actually happened (the row was in
  // an overwritable state) — avoids a phantom CAUGHT_UP on a held company.
  if (count > 0) {
    await logCompanyEvent({
      userId,
      companyId,
      type: CompanyEventType.CAUGHT_UP,
      notes: "Caught up — nothing actionable right now.",
    });
  }
}

// Land a company after a filtering pass over its board: anything left to look at
// → READY, nothing left → CAUGHT_UP. Never CLOSED — a filter that only read
// metadata is the weakest evidence in the system, and "this whole company is a
// dead-end" is a body-read call (the shortlist's), not a title-scan one.
export async function markCompanyPostFilter(
  companyId: string,
  userId: string,
  survivingJobs: number,
): Promise<void> {
  if (survivingJobs > 0) await markCompanyReady(companyId, userId);
  else await markCompanyCaughtUp(companyId, userId);
}
