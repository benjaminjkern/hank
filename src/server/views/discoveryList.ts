// The discovery list view — companies the search has proposed that the user
// hasn't settled, plus what the recent rounds already decided. Feeds the
// panel's discovery screen (GET /api/discovery), Hank's discovery context
// block, and the find_companies arm's show event.
//
// The columns this reads are written elsewhere: the search (recordSuggestions),
// the panel clicks (setSuggestionMark), and the commit that settles them
// (procedures/registry/commitDiscovery).

import {
  CompanySuggestionMark,
  CompanySuggestionVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { MARK_WORDS } from "@/server/entities/companies/suggestionMark";
import { nowMs } from "@/utils/now";

export type DiscoveryRow = {
  id: string;
  name: string;
  reason: string;
  url: string | null;
  // Null = unmarked, which is a real state, not a missing one: the candidate
  // stays on the table and the next search can re-offer it.
  mark: "add" | "pass" | null;
};

export type DiscoverySettledRow = {
  id: string;
  name: string;
  reason: string;
  verdict: "added" | "declined";
};

export type DiscoveryListView = {
  // Still open: the pool, newest proposal first.
  open: DiscoveryRow[];
  // Collapsed tails, so a round is legible afterwards and a mis-tapped pass is
  // visible rather than simply gone.
  added: DiscoverySettledRow[];
  passed: DiscoverySettledRow[];
  // How many open rows carry a mark Hank hasn't been told about — what the
  // composer's pending chip counts.
  pendingMarks: number;
};

// How far back the settled tails reach. The open pool has its own (longer)
// window in companySuggestions.ts; this is only about how much history the
// panel is worth showing.
const SETTLED_WINDOW_DAYS = 7;
const SETTLED_LIMIT = 40;

const MARK_NAME: Record<CompanySuggestionMark, "add" | "pass"> = {
  [CompanySuggestionMark.ADD]: "add",
  [CompanySuggestionMark.PASS]: "pass",
};

export async function loadDiscoveryList(
  userId: string,
): Promise<DiscoveryListView> {
  const since = new Date(nowMs() - SETTLED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [openRows, settledRows] = await Promise.all([
    prisma.companySuggestion.findMany({
      where: { userId, verdict: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        nameKey: true,
        reason: true,
        url: true,
        userMark: true,
        relayedMark: true,
      },
    }),
    prisma.companySuggestion.findMany({
      where: { userId, verdict: { not: null }, decidedAt: { gte: since } },
      orderBy: { decidedAt: "desc" },
      take: SETTLED_LIMIT,
      select: {
        id: true,
        name: true,
        nameKey: true,
        reason: true,
        verdict: true,
      },
    }),
  ]);

  // Newest row wins per name. recordSuggestions keeps one open row per name, so
  // a duplicate here predates that — still worth folding rather than drawing
  // the same company twice.
  const seen = new Set<string>();
  const open: DiscoveryRow[] = [];
  let pendingMarks = 0;
  for (const r of openRows) {
    if (seen.has(r.nameKey)) continue;
    seen.add(r.nameKey);
    if (r.userMark !== r.relayedMark) pendingMarks += 1;
    open.push({
      id: r.id,
      name: r.name,
      reason: r.reason,
      url: r.url,
      mark: r.userMark ? MARK_NAME[r.userMark] : null,
    });
  }

  const added: DiscoverySettledRow[] = [];
  const passed: DiscoverySettledRow[] = [];
  for (const r of settledRows) {
    const row = { id: r.id, name: r.name, reason: r.reason };
    if (r.verdict === CompanySuggestionVerdict.ADDED) {
      added.push({ ...row, verdict: "added" });
    } else {
      passed.push({ ...row, verdict: "declined" });
    }
  }

  return { open, added, passed, pendingMarks };
}

// The same list as plain text for Hank's per-turn context. Marks included —
// negotiating over the list means knowing which ones the user already touched.
export function renderDiscoveryListText(view: DiscoveryListView): string {
  if (view.open.length === 0) return "";
  const line = (r: DiscoveryRow) =>
    `- ${r.name}${r.mark ? ` [${MARK_WORDS[r.mark === "add" ? CompanySuggestionMark.ADD : CompanySuggestionMark.PASS]}]` : ""} — ${r.reason}`;
  return [
    "# Companies on the user's screen right now, waiting on a decision",
    "Marked rows are what they've clicked; unmarked ones they haven't ruled on. Nothing here is committed — `commit_discovery` is what makes the marks real (adds the ADDs, records the PASSes). Don't re-list these in chat; they're already on screen.",
    view.open.map(line).join("\n"),
  ].join("\n");
}
