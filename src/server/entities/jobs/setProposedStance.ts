// Move one row's shortlist-board stance — the write behind both the user's
// panel buttons (the board edit route) and Hank's update_shortlist_proposal.
// A stance is negotiation state, not a decision: no status change, no JobEvent
// (the commit is the event). A null verdict clears the row back to undecided.
//
// Placement — which group the board DRAWS the row under — moves with the
// stance only when HANK sets it. A user's mark leaves placement alone so the
// row stays where they're looking at it; `settleRelayedBoardEdits` catches it
// up when their next message relays the change.
//
// Any role the board still considers can take a stance — including a still-NEW
// one, because marking it is not the same as reading it. Whether to ALSO read
// and promote the role is the caller's call (runReconsiderJob does it for
// interest, never for a rejection). Decided rows — closed, delisted, applied —
// aren't on the board at all; undoing a close is a repair
// (update_job_interaction), not a board move.

import {
  type JobInteractionStatus,
  ProposedBy,
  type ProposedVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { isStanceable } from "./shortlistPool";

export type SetProposedStanceResult =
  | { ok: true; title: string; priorVerdict: ProposedVerdict | null }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_ON_BOARD";
      status: JobInteractionStatus | null;
      title: string | null;
    };

export async function setProposedStance(args: {
  userId: string;
  jobId: string;
  // Null clears the row to undecided — the panel's un-select.
  verdict: ProposedVerdict | null;
  reason: string | null;
  by: ProposedBy;
  // Place the row under its new stance immediately instead of leaving it
  // pending. Defaults to true for Hank (his moves happen inside the
  // conversation the user is watching) and false for the user.
  place?: boolean;
}): Promise<SetProposedStanceResult> {
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    select: {
      id: true,
      status: true,
      proposedVerdict: true,
      job: { select: { title: true } },
    },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", status: null, title: null };
  if (!isStanceable(row.status)) {
    return {
      ok: false,
      code: "NOT_ON_BOARD",
      status: row.status,
      title: row.job.title,
    };
  }
  const place = args.place ?? args.by === ProposedBy.HANK;
  await prisma.jobInteraction.update({
    where: { id: row.id },
    data: {
      proposedVerdict: args.verdict,
      proposedReason: args.reason,
      proposedBy: args.by,
      proposedAt: new Date(),
      ...(place ? { placementVerdict: args.verdict } : {}),
    },
    select: { id: true },
  });
  return { ok: true, title: row.job.title, priorVerdict: row.proposedVerdict };
}
