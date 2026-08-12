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
import {
  isStanceable,
  onBoardWhere,
} from "@/server/entities/jobs/shortlistPool";

import { logCompanyEvent } from "./logCompanyEvent";

export type CommitShortlistResult =
  | { ok: false; code: "NO_OPEN_BOARD" }
  // The board would close a role whose application the user had already started
  // writing. Reported rather than done: everything else a commit does is
  // reversible in a sentence, and this one throws away work in progress, so it
  // asks first. Hank re-calls with `confirmed` once the user says go.
  | { ok: false; code: "CONFIRM_CLOSING_STARTED"; startedTitles: string[] }
  | { ok: true; picked: number; setAside: number; closed: number };

export async function commitShortlist(args: {
  userId: string;
  companyId: string;
  // Set only after the user has agreed to close a role they'd started applying
  // to. Leave unset on the first call.
  confirmed?: boolean;
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
      agentVerdict: true,
      agentReason: true,
      userVerdict: true,
      job: { select: { title: true } },
    },
  });
  if (rows.length === 0) return { ok: false, code: "NO_OPEN_BOARD" };

  // Ask before throwing away a draft. A started application is the one thing on
  // a board that can't be restored by re-marking a row: the text survives on the
  // record, but the role is closed and out of every pool that would surface it.
  // Deferring one is fine unasked — it stays in the pool and the draft is
  // untouched.
  const closingStarted = rows.filter(
    (r) =>
      r.status === JobInteractionStatus.APPLYING &&
      (r.userVerdict ?? r.agentVerdict) === ProposedVerdict.PASS,
  );
  if (closingStarted.length > 0 && !args.confirmed) {
    return {
      ok: false,
      code: "CONFIRM_CLOSING_STARTED",
      startedTitles: closingStarted.map((r) => r.job.title),
    };
  }

  const now = new Date();
  const eventItems: LogJobEventInput[] = [];
  // Rows already at their stance's target status get no event — just the
  // stance cleared (and the note refreshed), so a re-commit is idempotent.
  const noOpUpdates: Array<{
    id: string;
    data: Prisma.JobInteractionUncheckedUpdateInput;
  }> = [];
  const clearStance = {
    agentVerdict: null,
    userVerdict: null,
    placementVerdict: null,
    agentReason: null,
    // Cleared with the stance it qualifies: the round is over, so "which pass
    // ruled this out" is no longer a live proposal. A row that ends up CLOSED
    // keeps its closeReason/closeNote, which is the durable record.
    eliminatedBy: null,
    stanceAt: null,
  };

  let picked = 0;
  let setAside = 0;
  let closed = 0;
  for (const row of rows) {
    // The role moved past the board while the round was open — applied to,
    // answered, interviewed, delisted. The stance was a proposal about a
    // decision that has since been made for real, so it is dropped rather than
    // acted on: honouring a stale `pick` here writes SHORTLISTED over an APPLIED
    // role, which is the board undoing what the user told Hank they'd done.
    // (CLOSED is deliberately not in this set — a mark on a filtered row is the
    // un-close, and `isStanceable` says so.)
    if (!isStanceable(row.status)) {
      noOpUpdates.push({ id: row.id, data: { ...clearStance } });
      continue;
    }
    // The user's override when they made one, otherwise Hank's proposal.
    const reason = row.agentReason;
    switch (row.userVerdict ?? row.agentVerdict) {
      case ProposedVerdict.PICK: {
        picked++;
        // APPLYING as well as SHORTLISTED: picking a role whose application is
        // already being written is agreement, not a fresh selection, and writing
        // SHORTLISTED over it would say "queued" about the one in progress.
        if (
          row.status === JobInteractionStatus.SHORTLISTED ||
          row.status === JobInteractionStatus.APPLYING
        ) {
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
              CompanyStatus.SHORTLISTING,
              CompanyStatus.CAUGHT_UP,
              CompanyStatus.IN_FLIGHT,
              CompanyStatus.IN_PROCESS,
            ],
          },
        },
        data: { status: CompanyStatus.APPLYING },
      });
    } else {
      // Nothing picked, so there is nothing to work — but the board is settled
      // either way, and SHORTLISTING means "waiting on you". Land READY and let
      // the walkthrough's own tail decide whether this company is caught up.
      await tx.companyInteraction.updateMany({
        where: { userId, companyId, status: CompanyStatus.SHORTLISTING },
        data: { status: CompanyStatus.READY },
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
