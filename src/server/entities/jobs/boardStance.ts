// A stance on a shortlist row: where the board DRAWS the row, what the mark is
// called, and the relay that carries a user's hand-edits into the next message.
// The board view groups by these rules; the relay is the only path from a panel
// click to Hank's context.

import {
  JobDeferReason,
  JobInteractionStatus,
  ProposedVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { onBoardWhere } from "./shortlistPool";

export const STANCE_WORDS: Record<ProposedVerdict, string> = {
  [ProposedVerdict.PICK]: "pick",
  [ProposedVerdict.BORDERLINE]: "borderline",
  [ProposedVerdict.PASS]: "pass",
};

// Where the board currently DRAWS a row, as a stance. `placementVerdict` when
// the row has been placed; otherwise the equivalent of what the last commit
// decided, because a committed pick is sitting in the picks group whether or
// not a column says so.
//
// This is the row's "you are here", and it is the single thing a mark is
// compared against — which is what makes marking a role back to where it
// already sits a no-op rather than a change. Reading it off the raw column
// instead reports a committed pick re-marked `pick` as an edit.
export type PlaceableRow = {
  status: JobInteractionStatus;
  placementVerdict: ProposedVerdict | null;
  deferReason: JobDeferReason | null;
};

export function placedVerdict(row: PlaceableRow): ProposedVerdict | null {
  if (row.placementVerdict) return row.placementVerdict;
  if (row.status === JobInteractionStatus.SHORTLISTED) {
    return ProposedVerdict.PICK;
  }
  if (
    row.status === JobInteractionStatus.DEFERRED &&
    row.deferReason === JobDeferReason.OUTRANKED
  ) {
    return ProposedVerdict.BORDERLINE;
  }
  return null;
}

// Whether a row's mark differs from where it's drawn — an unrelayed user edit.
// Requires the row to be ON the board: a committed row carries neither a stance
// nor a placement, and `placedVerdict`'s status fallback would otherwise read
// every settled pick as a pending change to undecided.
export function isPending(
  row: PlaceableRow & { proposedVerdict: ProposedVerdict | null },
): boolean {
  const onBoard = row.proposedVerdict !== null || row.placementVerdict !== null;
  return onBoard && row.proposedVerdict !== placedVerdict(row);
}

export type BoardEditRelay = {
  jobId: string;
  title: string;
  companyName: string | null;
  // The stance the user landed on. Null = they cleared it back to undecided.
  verdict: ProposedVerdict | null;
  reason: string | null;
};

// Board rows the user marked but hasn't sent a message about yet — the edit
// relay. appendUserMessage snapshots these into a `panel_edits` block on the
// new user row (chip for the user, prose for the model), which is the ONLY
// relay: an edit persists immediately but never wakes Hank on its own.
//
// "Unrelayed" is the divergence between a row's mark and where it's DRAWN
// (`placedVerdict`), not a timestamp window: the user's edits move
// `proposedVerdict` alone, and `settleRelayedBoardEdits` below catches
// placement up once they've been reported. So this is order-independent (no
// anchor row to race) and a mark that lands back where the row already sits
// reports nothing at all, because nothing about the board changed.
export async function listUnrelayedBoardEdits(
  userId: string,
): Promise<BoardEditRelay[]> {
  const rows = await prisma.jobInteraction.findMany({
    where: { userId, ...onBoardWhere() },
    orderBy: { proposedAt: "asc" },
    select: {
      status: true,
      deferReason: true,
      proposedVerdict: true,
      placementVerdict: true,
      proposedReason: true,
      job: {
        select: {
          id: true,
          title: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  return rows.filter(isPending).map((r) => ({
    jobId: r.job.id,
    title: r.job.title,
    companyName: r.job.company?.name ?? null,
    verdict: r.proposedVerdict,
    reason: r.proposedReason,
  }));
}

// Catch placement up to the live stance for the rows just relayed — the "new
// chat pass" that lets them re-file into their new groups. Grouped by target
// stance so the write is a fixed number of statements (four at most),
// never one per row.
export async function settleRelayedBoardEdits(
  userId: string,
  edits: BoardEditRelay[],
): Promise<void> {
  if (edits.length === 0) return;
  const byVerdict = new Map<ProposedVerdict | null, string[]>();
  for (const e of edits) {
    const list = byVerdict.get(e.verdict) ?? [];
    list.push(e.jobId);
    byVerdict.set(e.verdict, list);
  }
  await prisma.$transaction(
    [...byVerdict].map(([verdict, jobIds]) =>
      prisma.jobInteraction.updateMany({
        where: { userId, jobId: { in: jobIds } },
        data: { placementVerdict: verdict },
      }),
    ),
  );
}

// The model-facing prose for a relay — rendered once at write time and
// snapshotted into the block, so replay needs no renderer and can't drift.
export function renderBoardEditRelayText(edits: BoardEditRelay[]): string {
  const lines = edits.map((e) => {
    const move = e.verdict
      ? `moved to ${STANCE_WORDS[e.verdict]}`
      : "cleared back to undecided";
    return `- ${e.title}${e.companyName ? ` (${e.companyName})` : ""}: ${move}${e.reason ? ` — "${e.reason}"` : ""}`;
  });
  return `(From the shortlist board — the user changed ${edits.length === 1 ? "this row" : "these rows"} by hand since their last message:\n${lines.join("\n")})`;
}
