// Move one row's shortlist-board stance — the write behind Hank's
// update_shortlist_proposal and the user's panel buttons.
//
// The two sides write DIFFERENT columns, which is the whole point: Hank owns
// `agentVerdict`/`agentReason`, the user owns `userVerdict`, and neither can
// erase the other. A user marking a row back onto Hank's proposal clears
// `userVerdict` to null — so his reason reappears because it was never touched.
//
// A stance is negotiation state, not a decision: no status change, no JobEvent
// (the commit is the event).
//
// Placement — which group the board DRAWS the row under — moves with the stance
// only when HANK sets it. A user's mark leaves placement alone so the row stays
// where they're looking at it; `settleRelayedBoardEdits` catches it up when
// their next message relays the change.
//
// Any role the board still considers can take a stance — including a still-NEW
// one, because marking it is not the same as reading it. Whether to ALSO read
// and promote the role is the caller's call (runReconsiderJob does it for
// interest, never for a rejection).

import { prisma } from "@/server/db/prisma";
import {
  JobInteractionStatus,
  ProposedVerdict,
} from "@/generated/prisma/client";

import { isStanceable } from "./shortlistPool";

export type SetBoardStanceResult =
  | { ok: true; title: string; priorVerdict: ProposedVerdict | null }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_ON_BOARD";
      status: JobInteractionStatus | null;
      title: string | null;
    };

// Who is moving the row, and what that lets them say. Hank proposes WITH a
// rationale; the user only picks a verdict — and `null` from them is not
// "undecided", it's "whatever you said", which is what makes reverting free.
export type BoardStanceMove =
  | { by: "agent"; verdict: ProposedVerdict | null; reason: string | null }
  | { by: "user"; verdict: ProposedVerdict | null };

export async function setBoardStance(
  args: {
    userId: string;
    jobId: string;
    // Place the row under its new stance immediately instead of leaving it
    // pending. Defaults to true for Hank (his moves happen inside the
    // conversation the user is watching) and false for the user.
    place?: boolean;
  } & BoardStanceMove,
): Promise<SetBoardStanceResult> {
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    select: {
      id: true,
      status: true,
      agentVerdict: true,
      userVerdict: true,
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

  const priorVerdict = row.userVerdict ?? row.agentVerdict;
  const place = args.place ?? args.by === "agent";
  // Marking a row onto what Hank already proposed IS accepting it, so it stores
  // as null rather than as a duplicate of his verdict. Without this, "changed
  // my mind back" would read as a standing disagreement forever.
  const userVerdict =
    args.by === "user" && args.verdict === row.agentVerdict
      ? null
      : args.verdict;

  await prisma.jobInteraction.update({
    where: { id: row.id },
    data: {
      ...(args.by === "agent"
        ? {
            agentVerdict: args.verdict,
            agentReason: args.reason,
            // Hank restating a position the user had moved supersedes their
            // override — otherwise his new verdict would sit under their old one.
            userVerdict: null,
          }
        : { userVerdict }),
      stanceAt: new Date(),
      ...(place
        ? { placementVerdict: args.by === "agent" ? args.verdict : userVerdict }
        : {}),
    },
    select: { id: true },
  });
  return { ok: true, title: row.job.title, priorVerdict };
}
