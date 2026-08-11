// A mark on a discovery candidate, and the relay that carries the user's panel
// clicks into Hank's next message. The discovery list groups by these rules;
// the relay is the only path from a panel click to his context.
//
// Three states, two buttons: ADD, PASS, and **unmarked** — which is not an
// absence but the pool ("still on the table", carried into the next search).
// Clicking the active mark clears back to it, exactly as the board clears to
// undecided.
//
// A mark is not a decision. `userMark` is what the user clicked; `verdict` is
// what `commit_discovery` settled. Keeping them apart is what lets the user
// change their mind before sending, and what stops a panel click from costing a
// URL hunt.

import {
  CompanySuggestionMark,
  type CompanySuggestionVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { nowDate } from "@/utils/now";

export const MARK_WORDS: Record<CompanySuggestionMark, string> = {
  [CompanySuggestionMark.ADD]: "add",
  [CompanySuggestionMark.PASS]: "pass",
};

// A candidate is on the discovery list until a commit settles it.
export function openSuggestionWhere() {
  return { verdict: null } as const;
}

export type SuggestionMarkRelay = {
  id: string;
  name: string;
  // Where the user landed. Null = they cleared it back to unmarked.
  mark: CompanySuggestionMark | null;
};

// Write one mark. Idempotent by construction — the panel sends the state it
// wants, not a toggle, so a double-click can't land somewhere neither side
// expects. Refuses a settled row: a committed candidate is a record, not a
// working surface.
export async function setSuggestionMark(args: {
  userId: string;
  suggestionId: string;
  mark: CompanySuggestionMark | null;
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

// Marks the user has made but not yet sent a message about.
//
// "Unrelayed" is the divergence between `userMark` and `relayedMark`, not a
// timestamp window — so it's order-independent, and a mark that lands back
// where Hank already believes it sits reports nothing at all.
export async function listUnrelayedSuggestionMarks(
  userId: string,
): Promise<SuggestionMarkRelay[]> {
  const rows = await prisma.companySuggestion.findMany({
    where: { userId, ...openSuggestionWhere() },
    orderBy: { markedAt: "asc" },
    select: { id: true, name: true, userMark: true, relayedMark: true },
  });
  return rows
    .filter((r) => r.userMark !== r.relayedMark)
    .map((r) => ({ id: r.id, name: r.name, mark: r.userMark }));
}

// Catch `relayedMark` up for the rows just reported. Grouped by target mark so
// the write is a fixed number of statements (three at most), never one per row.
export async function settleRelayedSuggestionMarks(
  userId: string,
  relays: SuggestionMarkRelay[],
): Promise<void> {
  if (relays.length === 0) return;
  const byMark = new Map<CompanySuggestionMark | null, string[]>();
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
export function renderSuggestionMarkRelayText(
  relays: SuggestionMarkRelay[],
): string {
  const adds = relays.filter((r) => r.mark === CompanySuggestionMark.ADD);
  const passes = relays.filter((r) => r.mark === CompanySuggestionMark.PASS);
  const cleared = relays.filter((r) => r.mark === null);
  const parts: string[] = [];
  if (adds.length > 0) {
    parts.push(`- to add: ${adds.map((r) => r.name).join(", ")}`);
  }
  if (passes.length > 0) {
    parts.push(`- passing on: ${passes.map((r) => r.name).join(", ")}`);
  }
  if (cleared.length > 0) {
    parts.push(`- back to undecided: ${cleared.map((r) => r.name).join(", ")}`);
  }
  return [
    "(From the company list on their screen — the user marked these by hand since their last message. Nothing is committed yet: call commit_discovery to make it real, unless what they typed says to hold off or changes which ones they mean.)",
    ...parts,
  ].join("\n");
}

// Every marked candidate, for the commit. Reads `userMark` rather than the
// relay column: the commit acts on what the user last clicked, including a mark
// made in the same message that triggered it.
export type MarkedSuggestion = {
  id: string;
  name: string;
  reason: string;
  url: string | null;
  mark: CompanySuggestionMark;
};

export async function listMarkedSuggestions(
  userId: string,
): Promise<MarkedSuggestion[]> {
  const rows = await prisma.companySuggestion.findMany({
    where: { userId, ...openSuggestionWhere(), userMark: { not: null } },
    orderBy: { markedAt: "asc" },
    select: {
      id: true,
      name: true,
      reason: true,
      url: true,
      userMark: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    reason: r.reason,
    url: r.url,
    mark: r.userMark!,
  }));
}

// Settle the marked rows by id — the commit's write half. Ids rather than
// nameKeys because the commit acts on rows it just read, and grouped by verdict
// so it stays two statements.
export async function settleMarkedSuggestions(args: {
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
