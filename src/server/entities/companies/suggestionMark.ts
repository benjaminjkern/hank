// A mark on a discovery candidate, and the relay that carries the user's panel
// clicks into Hank's next message. The discovery list renders by these rules;
// the relay is the only path from a panel click to his context.
//
// **Every candidate is proposed as ADD.** Surfacing a company IS the proposal
// that it's worth tracking, so the list arrives fully checked and the user's job
// is to uncheck what they don't want and say go — the same "agree costs no
// clicks" shape the shortlist board has.
//
// So `userMark` is the OVERRIDE, and **null means "I accept the proposal"**.
// That's what makes re-checking a row a true revert rather than a second state,
// and it's why the live mark is `userMark ?? ADD` everywhere rather than a raw
// column read.
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

// What the search proposes for every candidate it surfaces.
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
  relayedMark: CompanySuggestionMark | null;
};

// The mark in force: the user's when they've set one, otherwise the proposal.
export function liveMark(
  mark: CompanySuggestionMark | null,
): CompanySuggestionMark {
  return mark ?? PROPOSED_MARK;
}

// Whether a row's mark differs from what Hank was last told. Compared through
// `liveMark` on BOTH sides so a never-touched row (both null) and a row
// re-checked back to the proposal both read as settled — nothing to report when
// nothing about the list changed.
export function isPending(row: MarkedRow): boolean {
  return liveMark(row.userMark) !== liveMark(row.relayedMark);
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
    select: { id: true, name: true, userMark: true, relayedMark: true },
  });
  return rows
    .filter(isPending)
    .map((r) => ({ id: r.id, name: r.name, mark: liveMark(r.userMark) }));
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
    select: { id: true, userMark: true, relayedMark: true },
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
    "(From the company list on their screen — every company you found starts checked, and the user changed these by hand since their last message. Nothing is committed yet: call commit_discovery to add everything still checked and record the rest, unless what they typed says to hold off or to look again instead.)",
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
