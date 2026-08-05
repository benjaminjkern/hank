// Commit the shortlist board at one company — the moment the negotiation ends
// and statuses actually change. Every row carrying a stance is decided:
//   PICK       → SHORTLISTED
//   BORDERLINE → DEFERRED (OUTRANKED), deferNote ← the stance reason
//   PASS       → CLOSED (NOT_A_MATCH), closeNote ← the stance reason
// A row the user cleared to undecided decides nothing but still comes off the
// board; rows never on it are untouched, and the next seed covers them.
// Anything picked bumps the company to APPLYING; the whole decision collapses
// to ONE SHORTLIST_RAN company event (batch-seam rule).
//
// A coherent set of writes in one transaction — a mutation, not a chain of
// steps — which is why it lives in entities (same shape as closeCompany).

import {
  CompanyEventType,
  CompanyStatus,
  JobCloseReason,
  JobDeferReason,
  JobEventType,
  JobInteractionStatus,
  ProposedVerdict,
} from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { bulkUpdate, type Database } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";
import { planJobEvents } from "@/server/entities/jobs/logJobEvents";
import type { LogJobEventInput } from "@/server/entities/jobs/logJobEvents";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";

import { logCompanyEvent } from "./logCompanyEvent";

export type CommitShortlistResult =
  | { ok: false; code: "NO_OPEN_BOARD" }
  | { ok: true; picked: number; setAside: number; closed: number };

export async function commitShortlist(args: {
  userId: string;
  companyId: string;
}): Promise<CommitShortlistResult> {
  const { userId, companyId } = args;
  // Every row on the board, including ones the user cleared to undecided —
  // those decide nothing but still need their placement wiped, or the board
  // reads as open after the commit.
  const rows = await prisma.jobInteraction.findMany({
    where: { userId, job: { companyId }, ...onBoardWhere() },
    select: {
      id: true,
      jobId: true,
      status: true,
      deferReason: true,
      proposedVerdict: true,
      proposedReason: true,
    },
  });
  if (rows.length === 0) return { ok: false, code: "NO_OPEN_BOARD" };

  const now = new Date();
  const eventItems: LogJobEventInput[] = [];
  // Rows already at their stance's target status get no event — just the
  // stance cleared (and the note refreshed), so a re-commit is idempotent.
  const noOpUpdates: Array<{
    id: string;
    data: Prisma.JobInteractionUncheckedUpdateInput;
  }> = [];
  const clearStance = {
    proposedVerdict: null,
    placementVerdict: null,
    proposedReason: null,
    proposedBy: null,
    proposedAt: null,
  };

  let picked = 0;
  let setAside = 0;
  let closed = 0;
  for (const row of rows) {
    const reason = row.proposedReason;
    switch (row.proposedVerdict) {
      case ProposedVerdict.PICK: {
        picked++;
        if (row.status === JobInteractionStatus.SHORTLISTED) {
          noOpUpdates.push({ id: row.id, data: { ...clearStance } });
        } else {
          eventItems.push({
            jobId: row.jobId,
            type: JobEventType.SHORTLISTED,
            occurredAt: now,
            notes: reason,
            jobInteractionUpdate: {
              status: JobInteractionStatus.SHORTLISTED,
              closeReason: null,
              closeNote: null,
              deferReason: null,
              deferNote: null,
            },
          });
        }
        break;
      }
      case ProposedVerdict.BORDERLINE: {
        setAside++;
        if (
          row.status === JobInteractionStatus.DEFERRED &&
          row.deferReason === JobDeferReason.OUTRANKED
        ) {
          noOpUpdates.push({
            id: row.id,
            data: { ...clearStance, deferNote: reason },
          });
        } else {
          eventItems.push({
            jobId: row.jobId,
            type: JobEventType.DEFERRED,
            occurredAt: now,
            notes: reason,
            jobInteractionUpdate: {
              status: JobInteractionStatus.DEFERRED,
              deferReason: JobDeferReason.OUTRANKED,
              deferNote: reason,
              closeReason: null,
              closeNote: null,
            },
          });
        }
        break;
      }
      // Undecided (the user cleared it): decide nothing, just take it off the
      // board. It stays SCANNED and the next seed re-ranks it.
      case null: {
        noOpUpdates.push({ id: row.id, data: { ...clearStance } });
        break;
      }
      case ProposedVerdict.PASS: {
        closed++;
        if (row.status === JobInteractionStatus.CLOSED) {
          noOpUpdates.push({ id: row.id, data: { ...clearStance } });
        } else {
          eventItems.push({
            jobId: row.jobId,
            type: JobEventType.CLOSED,
            occurredAt: now,
            notes: reason,
            jobInteractionUpdate: {
              status: JobInteractionStatus.CLOSED,
              closeReason: JobCloseReason.NOT_A_MATCH,
              closeNote: reason,
              deferReason: null,
              deferNote: null,
            },
          });
        }
        break;
      }
    }
  }

  // The whole commit — every event, every stance clear, and the company bump —
  // in one transaction at a constant statement count. A board can carry a
  // hundred rows; the stance clears differ per row, so they go through
  // bulkUpdate rather than a round trip each.
  const plan = await planJobEvents(userId, eventItems);
  await prisma.$transaction(async (tx) => {
    await plan.write(tx);
    await bulkUpdate(
      "JobInteraction",
      "id",
      noOpUpdates.map(({ id, data }) => ({
        key: id,
        patch: data as Partial<Database["JobInteraction"]>,
      })),
      tx,
    );
    if (picked > 0) {
      await tx.companyInteraction.updateMany({
        where: {
          userId,
          companyId,
          status: {
            in: [
              CompanyStatus.NEW,
              CompanyStatus.READY,
              CompanyStatus.CAUGHT_UP,
              CompanyStatus.IN_FLIGHT,
              CompanyStatus.IN_PROCESS,
            ],
          },
        },
        data: { status: CompanyStatus.APPLYING },
      });
    }
  });

  // One collapsed company-feed row for the whole decision. Best-effort — a
  // feed write must never unwind the commit.
  await logCompanyEvent({
    userId,
    companyId,
    type: CompanyEventType.SHORTLIST_RAN,
    occurredAt: now,
    notes: `Shortlisted ${picked}, set aside ${setAside}, closed ${closed}`,
  });

  return { ok: true, picked, setAside, closed };
}
