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
import { currentBatch } from "@/server/entities/companies/companySuggestions";
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
  // What the search established about the company. Null on a row Hank added
  // himself and on rows written before the search returned one.
  summary: string | null;
  url: string | null;
  // False means the mark in force is "pass" — the user unchecked it, or Hank
  // did on their say-so.
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
      summary: true,
      url: true,
      runId: true,
      createdAt: true,
      userMark: true,
      agentMark: true,
      relayedMark: true,
    },
  });
  // No open candidate anywhere: the last commit settled the batch, so there is
  // nothing to negotiate over rather than an empty negotiation.
  if (open.length === 0) {
    return { rows: [], open: false, pendingCount: 0, openThreadCount: 0 };
  }

  // One run only — the rule lives in entities/ because Hank's own edits have to
  // land on the same batch this draws.
  const batch = currentBatch(open);

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
      summary: r.summary,
      url: r.url,
      checked: liveMark(r) === "ADD",
      pending,
    });
  }
  return { rows, open: true, pendingCount, openThreadCount: 0 };
}

// The same list as plain text for Hank's per-turn context. Marks included —
// negotiating over the list means knowing which ones the user has unchecked.
//
// The summary rides along because "tell me more about that one" is the question
// this block exists to answer: without it he has a one-line fit case and his own
// general knowledge, and no way to tell the user which is which.
export function renderDiscoveryListText(view: DiscoveryListView): string {
  if (view.rows.length === 0) return "";
  const line = (r: DiscoveryRow) =>
    [
      `- ${r.name} [${r.checked ? MARK_WORDS.ADD : MARK_WORDS.PASS}] — ${r.reason}`,
      r.summary ? `  ${r.summary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  return [
    "# Companies on the user's screen right now, waiting on a decision",
    "Every one you found is checked to add by default; the user unchecks what they don't want, and you can mark one yourself with `update_discovery_proposal`. Nothing here is committed — `commit_discovery` adds everything still checked and records the rest. Don't re-list these in chat; they're already on screen.",
    "The indented line under a company is what the search actually established about it — that's what you answer from when the user asks about one. Anything beyond it is your own general knowledge, so say so.",
    view.rows.map(line).join("\n"),
  ].join("\n");
}
