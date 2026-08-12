// A mark on a discovery candidate, and the relay that carries the user's panel
// clicks into Hank's next message. The discovery list renders by these rules;
// the relay is the only path from a panel click to his context.
//
// **A candidate the search surfaced is proposed as ADD.** Surfacing a company IS
// the proposal that it's worth tracking, so the list arrives fully checked and
// the user's job is to uncheck what they don't want and say go — the same "agree
// costs no clicks" shape the shortlist board has.
//
// So `userMark` is the OVERRIDE, and **null means "I accept the proposal"**.
// That's what makes re-checking a row a true revert rather than a second state,
// and it's why the live mark is computed from the row rather than read off a
// column.
//
// The proposal is per-row rather than a constant because Hank can mark a row
// too ("drop H", "put Cohere on there") — `agentMark`. The three columns stack
// in one direction and only one of them is the user's: **user override, else
// Hank's mark, else ADD.** That ordering is what keeps his edits out of the
// pending count: pending compares the user's side against what he was last
// told, and both sides fall back to the same proposal, so a row only goes
// pending when the USER moved it.
//
// A mark is not a decision: `verdict` is what `commit_discovery` settles. Keeping
// them apart is what lets the user change their mind before sending, and what
// stops a checkbox click from costing a URL hunt.

import {
  CompanySuggestionMark,
  type CompanySuggestionVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { nowDate } from "@/utils/now";

import { currentBatch, suggestionKey } from "./companySuggestions";

// What the search proposes for every candidate it surfaces, and the floor of the
// fallback chain below.
export const PROPOSED_MARK = CompanySuggestionMark.ADD;

export const MARK_WORDS: Record<CompanySuggestionMark, string> = {
  [CompanySuggestionMark.ADD]: "add",
  [CompanySuggestionMark.PASS]: "pass",
};

// A candidate is on the discovery list until a commit settles it.
export function openSuggestionWhere() {
  return { verdict: null } as const;
}

type MarkedRow = {
  userMark: CompanySuggestionMark | null;
  agentMark: CompanySuggestionMark | null;
  relayedMark: CompanySuggestionMark | null;
};

// What this row is proposed as, with no user input: Hank's mark if he set one,
// otherwise the search's default.
export function proposedMark(
  row: Pick<MarkedRow, "agentMark">,
): CompanySuggestionMark {
  return row.agentMark ?? PROPOSED_MARK;
}

// The mark in force — what the checkbox shows and what the commit settles.
export function liveMark(row: MarkedRow): CompanySuggestionMark {
  return row.userMark ?? proposedMark(row);
}

// The mark Hank was last told about. Same fallback, so a row he has never been
// told anything about reads as its proposal rather than as a blank.
export function lastToldMark(row: MarkedRow): CompanySuggestionMark {
  return row.relayedMark ?? proposedMark(row);
}

// Whether a row's mark differs from what Hank was last told. Both sides fall
// back through the SAME proposal, so a never-touched row, a row re-checked back
// to the proposal, and a row Hank marked himself all read as settled — there is
// nothing to report when nothing the user did changed.
export function isPending(row: MarkedRow): boolean {
  return liveMark(row) !== lastToldMark(row);
}

export type SuggestionMarkRelay = {
  id: string;
  name: string;
  mark: CompanySuggestionMark;
};

// Write one mark. Idempotent by construction — the panel sends the state it
// wants, not a toggle, so a double-click can't land somewhere neither side
// expects. Refuses a settled row: a committed candidate is a record, not a
// working surface.
export async function setSuggestionMark(args: {
  userId: string;
  suggestionId: string;
  mark: CompanySuggestionMark;
}): Promise<{ ok: boolean }> {
  const updated = await prisma.companySuggestion.updateMany({
    where: {
      id: args.suggestionId,
      userId: args.userId,
      ...openSuggestionWhere(),
    },
    data: { userMark: args.mark, markedAt: nowDate() },
  });
  return { ok: updated.count > 0 };
}

// Hank's own mark on a candidate, by NAME — these aren't entities yet, so there
// is no slug to resolve. Find-or-create against the batch on screen: naming a
// company that isn't on the list is how it JOINS, which is the same dual role
// `setProposedStance` has on the shortlist board.
//
// A name that's open but stranded in an older batch is MOVED onto the current
// one rather than duplicated — the user asked for it on the list they're
// looking at, and `nameKey` is unique enough to make that unambiguous.
//
// Returns null when there is no open list at all. Starting one from a single
// hand-added name would put a one-row negotiation on screen that nobody asked
// for; a company the user named outright belongs on the watchlist directly
// (create_companies), not in a proposal.
export async function setAgentSuggestionMark(args: {
  userId: string;
  name: string;
  mark: CompanySuggestionMark;
  reason: string;
}): Promise<{
  name: string;
  mark: CompanySuggestionMark;
  added: boolean;
} | null> {
  // One read answers both questions — which row (if any) this name already has,
  // and which batch the panel is drawing — and taking the batch from the SAME
  // rows the panel scopes by is what stops a marked row landing off-screen.
  const open = await prisma.companySuggestion.findMany({
    where: { userId: args.userId, ...openSuggestionWhere() },
    orderBy: { createdAt: "desc" },
    select: { id: true, nameKey: true, runId: true },
  });
  if (open.length === 0) return null;
  const batchRunId = currentBatch(open)[0]?.runId ?? null;

  const nameKey = suggestionKey(args.name);
  const existing = open.find((r) => r.nameKey === nameKey);
  if (existing) {
    await prisma.companySuggestion.update({
      where: { id: existing.id },
      // runId moves too: a carried-forward row is stranded in a batch the panel
      // no longer draws, and marking it is a request to see it there.
      data: { agentMark: args.mark, reason: args.reason, runId: batchRunId },
    });
    return { name: args.name, mark: args.mark, added: false };
  }

  await prisma.companySuggestion.create({
    data: {
      userId: args.userId,
      name: args.name,
      nameKey,
      reason: args.reason,
      agentMark: args.mark,
      runId: batchRunId,
    },
  });
  return { name: args.name, mark: args.mark, added: true };
}

// Marks the user has changed but not yet sent a message about.
//
// "Unrelayed" is the divergence between the live user mark and the live relayed
// mark, not a timestamp window — so it's order-independent, and unchecking a row
// then re-checking it reports nothing at all.
export async function listUnrelayedSuggestionMarks(
  userId: string,
): Promise<SuggestionMarkRelay[]> {
  const rows = await prisma.companySuggestion.findMany({
    where: { userId, ...openSuggestionWhere() },
    orderBy: { markedAt: "asc" },
    select: {
      id: true,
      name: true,
      userMark: true,
      agentMark: true,
      relayedMark: true,
    },
  });
  return rows
    .filter(isPending)
    .map((r) => ({ id: r.id, name: r.name, mark: liveMark(r) }));
}

// Undo every unrelayed mark: put each row's live mark back to what Hank was last
// told, which is by definition the last thing he saw. A row he proposed and the
// user never touched is already there; the rest go back to `relayedMark`, which
// is `null` for a row that has only ever been the proposal.
//
// Nothing else has to be undone — a mark decides nothing until `commit_discovery`
// settles the batch, so a discarded row never left the list it was drawn in.
export async function discardUnrelayedSuggestionMarks(
  userId: string,
): Promise<number> {
  const rows = await prisma.companySuggestion.findMany({
    where: { userId, ...openSuggestionWhere() },
    select: { id: true, userMark: true, agentMark: true, relayedMark: true },
  });
  const pending = rows.filter(isPending);
  if (pending.length === 0) return 0;

  // Two shapes at most — back to a mark Hank was told, or back to the untouched
  // proposal — so the write stays two statements rather than one per row.
  const byMark = new Map<CompanySuggestionMark | null, string[]>();
  for (const r of pending) {
    byMark.set(r.relayedMark, [...(byMark.get(r.relayedMark) ?? []), r.id]);
  }
  await prisma.$transaction(
    [...byMark].map(([mark, ids]) =>
      prisma.companySuggestion.updateMany({
        where: { userId, id: { in: ids } },
        data: { userMark: mark },
      }),
    ),
  );
  return pending.length;
}

// Catch `relayedMark` up for the rows just reported. Grouped by target mark so
// the write is a fixed number of statements (two at most), never one per row.
export async function settleRelayedSuggestionMarks(
  userId: string,
  relays: SuggestionMarkRelay[],
): Promise<void> {
  if (relays.length === 0) return;
  const byMark = new Map<CompanySuggestionMark, string[]>();
  for (const r of relays) {
    byMark.set(r.mark, [...(byMark.get(r.mark) ?? []), r.id]);
  }
  await prisma.$transaction(
    [...byMark].map(([mark, ids]) =>
      prisma.companySuggestion.updateMany({
        where: { userId, id: { in: ids } },
        data: { relayedMark: mark },
      }),
    ),
  );
}

// The model-facing prose for a relay — rendered once at write time and
// snapshotted into the block, so replay needs no renderer and can't drift.
//
// Written as changes FROM the proposal, because that's what Hank has to respond
// to: everything he suggested is checked unless the user said otherwise.
export function renderSuggestionMarkRelayText(
  relays: SuggestionMarkRelay[],
): string {
  const dropped = relays.filter((r) => r.mark === CompanySuggestionMark.PASS);
  const restored = relays.filter((r) => r.mark === CompanySuggestionMark.ADD);
  const parts: string[] = [];
  if (dropped.length > 0) {
    parts.push(`- unchecked: ${dropped.map((r) => r.name).join(", ")}`);
  }
  if (restored.length > 0) {
    parts.push(`- checked back on: ${restored.map((r) => r.name).join(", ")}`);
  }
  return [
    [
      "(From the company list on their screen — every company you found starts checked, and the user changed these by hand since their last message. Nothing is committed yet.",
      "- If what they typed says to hold off, or tells you the batch is wrong, act on that instead — a push-back is a re-run, not a commit.",
      "- If they unchecked something and said nothing about why, ASK BEFORE COMMITTING. One question for the whole batch (\"what was off about those two?\"), then commit on whatever comes back — including \"no reason, just don't want it\". Don't ask twice, and don't ask about ones they only checked back on. A company they dropped is the most useful correction they can give you, and it's worth nothing unless you know what it was about.",
      "- Otherwise commit_discovery adds everything still checked and records the rest.)",
    ].join("\n"),
    ...parts,
  ].join("\n");
}

// Settle the batch — the commit's write half. Grouped by verdict so it stays
// two statements.
export async function settleSuggestionBatch(args: {
  userId: string;
  decided: Array<{ id: string; verdict: CompanySuggestionVerdict }>;
}): Promise<void> {
  if (args.decided.length === 0) return;
  const decidedAt = nowDate();
  const byVerdict = new Map<CompanySuggestionVerdict, string[]>();
  for (const d of args.decided) {
    byVerdict.set(d.verdict, [...(byVerdict.get(d.verdict) ?? []), d.id]);
  }
  await prisma.$transaction(
    [...byVerdict].map(([verdict, ids]) =>
      prisma.companySuggestion.updateMany({
        where: { userId: args.userId, id: { in: ids } },
        data: { verdict, decidedAt },
      }),
    ),
  );
}
