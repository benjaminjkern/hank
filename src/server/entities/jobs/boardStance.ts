// A stance on a shortlist row: whose verdict is live, where the board DRAWS the
// row, and the relay that carries a user's hand-edits into the next message.
// The board view groups by these rules; the relay is the only path from a panel
// click to Hank's context.
//
// Two sides, never one column. `agentVerdict`/`agentReason` are Hank's and only
// he writes them; `userVerdict` is the override, where **null means "I accept
// his"**. That's what makes re-marking a row back to his proposal restore his
// reason for free rather than leaving it destroyed — the same
// revert-is-a-no-op property the application page gets from `proposedDrafts`.

import {
  CompanyEventType,
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

// Both sides of the negotiation on one row.
export type StancedRow = {
  agentVerdict: ProposedVerdict | null;
  agentReason: string | null;
  userVerdict: ProposedVerdict | null;
};

// The stance in force: the user's when they've set one, otherwise Hank's.
export function liveVerdict(row: StancedRow): ProposedVerdict | null {
  return row.userVerdict ?? row.agentVerdict;
}

// The user has overruled Hank on this row — the one case worth showing his
// reasoning next to theirs, since on an untouched row his reason IS the row's.
export function isOverridden(row: StancedRow): boolean {
  return row.userVerdict !== null && row.userVerdict !== row.agentVerdict;
}

// On the board at all: someone has a verdict, or it's drawn somewhere.
export function isOnBoard(
  row: StancedRow & { placementVerdict: ProposedVerdict | null },
): boolean {
  return liveVerdict(row) !== null || row.placementVerdict !== null;
}

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
export function isPending(row: PlaceableRow & StancedRow): boolean {
  return isOnBoard(row) && liveVerdict(row) !== placedVerdict(row);
}

// When the round that produced the current board began. Closes at or after it
// are this round's automatic filtering; older ones belong to rounds the user
// already worked through, so they stay off the board.
//
// The board pull is the natural start (prescan runs on what the scrape just
// brought in), and a commit ends a round — so whichever is later wins. Null
// when the company has never been scraped: nothing to anchor on, so nothing
// closed is shown.
export async function roundStartedAt(
  userId: string,
  companyId: string,
): Promise<Date | null> {
  const [interaction, lastCommit] = await Promise.all([
    prisma.companyInteraction.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { lastScrapedJobsAt: true },
    }),
    prisma.companyEvent.findFirst({
      where: { userId, companyId, type: CompanyEventType.SHORTLIST_RAN },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    }),
  ]);
  const scraped = interaction?.lastScrapedJobsAt ?? null;
  const committed = lastCommit?.occurredAt ?? null;
  if (!scraped) return committed;
  if (!committed) return scraped;
  return scraped > committed ? scraped : committed;
}

export type BoardEditRelay = {
  jobId: string;
  title: string;
  companyName: string | null;
  // The stance the row now holds. Null only where Hank never ranked it and the
  // user hasn't either — there is no way for them to clear a mark back to
  // no-opinion.
  verdict: ProposedVerdict | null;
  // What Hank had proposed, so the relay can say what they moved it FROM —
  // "you had this as a pass" is the half he needs to respond to.
  agentVerdict: ProposedVerdict | null;
  agentReason: string | null;
};

// Board rows the user marked but hasn't sent a message about yet — the edit
// relay. appendUserMessage snapshots these into a `panel_edits` block on the
// new user row (chip for the user, prose for the model), which is the ONLY
// relay: an edit persists immediately but never wakes Hank on its own.
//
// "Unrelayed" is the divergence between a row's live stance and where it's
// DRAWN (`placedVerdict`), not a timestamp window: the user's edits move
// `userVerdict` alone, and `settleRelayedBoardEdits` below catches placement up
// once they've been reported. So this is order-independent (no anchor row to
// race) and a mark that lands back where the row already sits reports nothing at
// all, because nothing about the board changed.
export async function listUnrelayedBoardEdits(
  userId: string,
): Promise<BoardEditRelay[]> {
  const rows = await prisma.jobInteraction.findMany({
    where: { userId, ...onBoardWhere() },
    orderBy: { stanceAt: "asc" },
    select: {
      status: true,
      deferReason: true,
      agentVerdict: true,
      agentReason: true,
      userVerdict: true,
      placementVerdict: true,
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
    verdict: liveVerdict(r),
    agentVerdict: r.agentVerdict,
    agentReason: r.agentReason,
  }));
}

// Catch placement up to the live stance for the rows just relayed — the "new
// chat pass" that lets them re-file into their new groups. Grouped by target
// stance so the write is a fixed number of statements (four at most),
// never one per row.
//
// This is also where a filtered row gets UN-CLOSED. A mark on one is a proposal
// like any other, so nothing structural happens until Hank has seen it — which
// is what makes discarding unrelayed marks a pure stance clear, and what stops a
// mark-then-unmark from leaving a REVIVED event behind for something that never
// really changed.
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

// Undo every unrelayed mark: put each row's live stance back to where it's
// DRAWN, which is by definition the last thing Hank saw. Marks are the only
// thing there is to undo — a round changes no status until it is committed, so a
// discarded row was never anywhere but the pile it is sitting in.
//
// A row Hank proposed keeps his verdict (userVerdict cleared to null); a row he
// never ranked goes back to no mark at all.
export async function discardUnrelayedBoardEdits(
  userId: string,
): Promise<number> {
  const rows = await prisma.jobInteraction.findMany({
    where: { userId, ...onBoardWhere() },
    select: {
      id: true,
      status: true,
      deferReason: true,
      agentVerdict: true,
      agentReason: true,
      userVerdict: true,
      placementVerdict: true,
    },
  });
  const pending = rows.filter(isPending);
  if (pending.length === 0) return 0;

  // Two shapes at most: back to Hank's verdict (null), or back to a placement he
  // set that his own verdict no longer matches.
  const toAgent = pending.filter((r) => placedVerdict(r) === r.agentVerdict);
  const toPlacement = pending.filter(
    (r) => placedVerdict(r) !== r.agentVerdict,
  );
  await prisma.$transaction([
    ...(toAgent.length > 0
      ? [
          prisma.jobInteraction.updateMany({
            where: { id: { in: toAgent.map((r) => r.id) } },
            data: { userVerdict: null },
          }),
        ]
      : []),
    ...toPlacement.map((r) =>
      prisma.jobInteraction.update({
        where: { id: r.id },
        data: { userVerdict: placedVerdict(r) },
        select: { id: true },
      }),
    ),
  ]);
  return pending.length;
}

// The model-facing prose for a relay — rendered once at write time and
// snapshotted into the block, so replay needs no renderer and can't drift.
export function renderBoardEditRelayText(edits: BoardEditRelay[]): string {
  const lines = edits.map((e) => {
    const to = e.verdict
      ? `moved it to ${STANCE_WORDS[e.verdict]}`
      : "left it unranked";
    // What he had it as is the half he can actually respond to — "they moved
    // your pass to a pick" is a disagreement; "it's a pick now" is just state.
    const from = e.agentVerdict
      ? ` (you had it as ${STANCE_WORDS[e.agentVerdict]}${e.agentReason ? `: "${e.agentReason}"` : ""})`
      : "";
    return `- ${e.title}${e.companyName ? ` (${e.companyName})` : ""}: ${to}${from}`;
  });
  return `(From the shortlist board — the user changed ${edits.length === 1 ? "this row" : "these rows"} by hand since their last message. Your own reasoning is preserved on each row, so engage with the disagreement rather than restating it. If they overrode you and said nothing about why, ASK — once, covering all of them, before you commit the board. A stated reason carries to the next company; a silent override teaches you nothing:\n${lines.join("\n")})`;
}
