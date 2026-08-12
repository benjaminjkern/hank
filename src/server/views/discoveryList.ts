// The discovery list view — the companies the LAST search proposed, and nothing
// else. Feeds the panel's discovery screen (GET /api/discovery), Hank's
// discovery context block, and the find_companies arm's show event.
//
// **One run, not the whole pool.** Older unsettled candidates stay in the table
// as input to the next search (companySuggestions.ts) — they are how walking
// away from a list stops being lost work — but drawing them would put names on
// screen from a batch the user has forgotten, and would make the arm's "found
// you N companies" line disagree with what they can count. So the panel shows
// exactly one run: whichever produced the newest open row. A carried-forward
// name is re-recorded under the current run when the search re-proposes it, so
// it appears here on its own merits rather than as a leftover.
//
// The columns this reads are written elsewhere: the search (recordSuggestions),
// the panel clicks (setSuggestionMark), and the commit that settles them
// (procedures/registry/commitDiscovery).

import { prisma } from "@/server/db/prisma";
import {
  isPending,
  liveMark,
  MARK_WORDS,
} from "@/server/entities/companies/suggestionMark";
import type {
  NegotiationRow,
  NegotiationState,
} from "@/server/views/negotiationPanel";

export type DiscoveryRow = NegotiationRow & {
  id: string;
  name: string;
  reason: string;
  url: string | null;
  // Every candidate is proposed as "add"; false means the user unchecked it.
  checked: boolean;
};

// `openThreadCount` is always 0: a candidate is a name and a reason, so there is
// nothing here Hank can ask about that unchecking doesn't already answer.
export type DiscoveryListView = NegotiationState & {
  rows: DiscoveryRow[];
};

export async function loadDiscoveryList(
  userId: string,
): Promise<DiscoveryListView> {
  const open = await prisma.companySuggestion.findMany({
    where: { userId, verdict: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      nameKey: true,
      reason: true,
      url: true,
      runId: true,
      createdAt: true,
      userMark: true,
      relayedMark: true,
    },
  });
  // No open candidate anywhere: the last commit settled the batch, so there is
  // nothing to negotiate over rather than an empty negotiation.
  if (open.length === 0) {
    return { rows: [], open: false, pendingCount: 0, openThreadCount: 0 };
  }

  // The newest open row names the current batch. Keyed on runId when there is
  // one; a null runId (a hand-driven or replayed write) can't be told apart
  // from any other, so those rows only ever form a batch among themselves.
  const newest = open[0];
  const batch = open.filter((r) =>
    newest.runId === null ? r.runId === null : r.runId === newest.runId,
  );

  // One row per name — recordSuggestions keeps it that way, so a duplicate here
  // predates that and is still worth folding rather than drawing twice.
  const seen = new Set<string>();
  const rows: DiscoveryRow[] = [];
  let pendingCount = 0;
  for (const r of batch) {
    if (seen.has(r.nameKey)) continue;
    seen.add(r.nameKey);
    const pending = isPending(r);
    if (pending) pendingCount += 1;
    rows.push({
      id: r.id,
      name: r.name,
      reason: r.reason,
      url: r.url,
      checked: liveMark(r.userMark) === "ADD",
      pending,
    });
  }
  return { rows, open: true, pendingCount, openThreadCount: 0 };
}

// The same list as plain text for Hank's per-turn context. Marks included —
// negotiating over the list means knowing which ones the user has unchecked.
export function renderDiscoveryListText(view: DiscoveryListView): string {
  if (view.rows.length === 0) return "";
  const line = (r: DiscoveryRow) =>
    `- ${r.name} [${r.checked ? MARK_WORDS.ADD : MARK_WORDS.PASS}] — ${r.reason}`;
  return [
    "# Companies on the user's screen right now, waiting on a decision",
    "Every one you found is checked to add by default; the user unchecks what they don't want. Nothing here is committed — `commit_discovery` adds everything still checked and records the rest. Don't re-list these in chat; they're already on screen.",
    view.rows.map(line).join("\n"),
  ].join("\n");
}
