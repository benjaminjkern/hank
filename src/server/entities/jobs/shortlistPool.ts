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
// (SHORTLISTED), roles whose application was started and never finished
// (APPLYING), and committed passovers (DEFERRED + OUTRANKED). Intentional user
// defers (other reasons) are deliberately excluded — a fresh round must not yank
// those back.
//
// APPLYING is here because leaving it out made a half-written application
// INVISIBLE to the next round: not ranked, not on the board, so the user
// compared this company's roles against a picture missing the one they'd already
// committed to. It is ranked in place and never demoted on the way in — the
// status changes at commit like every other row's, so nothing about a started
// draft moves before the user has seen it on the board.
// The rows a fresh round RANKS. Narrower than "on the board": a role one of the
// automatic passes already stanced is judged for this round, so re-ranking it
// would pay the ranker to re-litigate a call the user can already see and
// overturn with one click.
export function shortlistPoolStatusWhere(): Prisma.JobInteractionWhereInput {
  return {
    // No stance from this round. A commit clears every stance, so "unstanced"
    // means "not yet judged by the round in progress" without any date to
    // compare against.
    agentVerdict: null,
    userVerdict: null,
    OR: [
      {
        status: {
          in: [
            JobInteractionStatus.SCANNED,
            JobInteractionStatus.SHORTLISTED,
            JobInteractionStatus.APPLYING,
          ],
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
      { agentVerdict: { not: null } },
      { userVerdict: { not: null } },
      { placementVerdict: { not: null } },
    ],
  };
}

// Roles the board still considers. Everything else is decided and lives on the
// company page's never-pursued list. The roles the automatic passes ruled out
// are in here too — they keep their status until the commit, so they are ordinary
// considered rows carrying a PASS stance rather than a special read-only tail.
export const CONSIDERED_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.APPLYING,
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
    select: { stanceAt: true, job: { select: { companyId: true } } },
  });
  const latestByCompany = new Map<string, Date>();
  for (const r of rows) {
    const companyId = r.job.companyId;
    if (!companyId) continue;
    const at = r.stanceAt ?? new Date(0);
    const prior = latestByCompany.get(companyId);
    if (!prior || at > prior) latestByCompany.set(companyId, at);
  }
  return [...latestByCompany.entries()]
    .map(([companyId, lastProposedAt]) => ({ companyId, lastProposedAt }))
    .sort((a, b) => b.lastProposedAt.getTime() - a.lastProposedAt.getTime());
}
