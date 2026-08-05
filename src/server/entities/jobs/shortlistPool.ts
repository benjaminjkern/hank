// Which roles a shortlist round is allowed to touch. One source of truth so the
// seed, the commit, the board view, and the reconsider path can't drift on what
// "the pool" means or on which rows a stance may be set against.

import {
  JobDeferReason,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

// The status subset of "what's in the shortlist pool" — the rows a seed ranks
// and a commit decides: read-and-ready (SCANNED), committed picks
// (SHORTLISTED), and committed passovers (DEFERRED + OUTRANKED). Intentional
// user defers (other reasons) are deliberately excluded — a fresh round must
// not yank those back.
export function shortlistPoolStatusWhere(): Prisma.JobInteractionWhereInput {
  return {
    OR: [
      {
        status: {
          in: [JobInteractionStatus.SCANNED, JobInteractionStatus.SHORTLISTED],
        },
      },
      {
        status: JobInteractionStatus.DEFERRED,
        deferReason: JobDeferReason.OUTRANKED,
      },
    ],
  };
}

// "This row is ON the board" — carrying a stance OR placed under a group. Both
// halves matter: a row the user cleared to undecided has no stance but is still
// part of the open negotiation, and re-seeding over it would wipe their work.
export function onBoardWhere(): Prisma.JobInteractionWhereInput {
  return {
    OR: [
      { proposedVerdict: { not: null } },
      { placementVerdict: { not: null } },
    ],
  };
}

// Roles the board still considers. Everything else is decided and lives on the
// company page's never-pursued list — with one exception the view adds back
// (this round's automatic closes, shown collapsed so the filtering is
// auditable). Those rows are read-only; every other row can take a stance.
export const CONSIDERED_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.DEFERRED,
];

export function isStanceable(status: JobInteractionStatus): boolean {
  return CONSIDERED_STATUSES.includes(status);
}

// Companies with an open negotiation for this user, most recently touched
// first. Drives Hank's board context block and the dashboard's "shortlist in
// progress" chips.
export async function listOpenShortlistBoards(
  userId: string,
): Promise<Array<{ companyId: string; lastProposedAt: Date }>> {
  const rows = await prisma.jobInteraction.findMany({
    where: { userId, ...onBoardWhere() },
    select: { proposedAt: true, job: { select: { companyId: true } } },
  });
  const latestByCompany = new Map<string, Date>();
  for (const r of rows) {
    const companyId = r.job.companyId;
    if (!companyId) continue;
    const at = r.proposedAt ?? new Date(0);
    const prior = latestByCompany.get(companyId);
    if (!prior || at > prior) latestByCompany.set(companyId, at);
  }
  return [...latestByCompany.entries()]
    .map(([companyId, lastProposedAt]) => ({ companyId, lastProposedAt }))
    .sort((a, b) => b.lastProposedAt.getTime() - a.lastProposedAt.getTime());
}
