// What the company search has proposed, and what the user did with it.
//
// Discovery's analogue of the board's stance columns: the record that makes a
// correction durable instead of a lost checkbox. A batch is written when it's
// rendered, settled when the user answers, and read back into the NEXT search's
// input — which is the whole loop.
//
// Suppression is ADVICE, not a filter. `listSuggestionHistory` hands the search
// what was declined and why; the prompt weighs it against this run's direction,
// so the user can talk their way past a past decline ("actually I'd look at
// bigger companies now") without any un-decline mechanism existing. The one
// deterministic rule rides on each entry's `inLatestRound` — re-proposing
// something declined in the round that just happened is never right.

import {
  CompanySuggestionVerdict,
  type CompanySuggestionDeclineReason,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { slugify } from "@/server/platform/slug/slugify";

import { SUGGESTION_DECLINE_LABELS } from "./companySuggestionInputs";

export type SuggestionToRecord = {
  name: string;
  reason: string;
  url?: string;
};

// One name's history as the search reads it. Counts and dates are here so the
// prompt can weigh a repeated recent decline differently from a lone stale one
// — the "fade" is the model's judgment, not a cutoff in code.
export type SuggestionHistoryEntry = {
  name: string;
  nameKey: string;
  verdict: CompanySuggestionVerdict;
  // Composed from the structured reason + note, or absent when they just
  // unchecked it.
  why?: string;
  timesDeclined: number;
  lastDecidedAt: Date;
  // Declined in the most recent answered round — the one case the search is
  // told never to re-propose unless this run's direction names it.
  inLatestRound: boolean;
};

// The search likes to qualify a name with the division it means — "The Trade
// Desk (Client Partnerships)", "Spotify (Advertising)". That's the same company
// as the bare name, so the qualifier comes off before keying or the history
// silently splits and the company gets proposed again under its other spelling.
function stripNameQualifier(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped.length > 0 ? stripped : name.trim();
}

// The identity a suggestion is remembered under. slugify is the same function
// Company.slug is minted with, so an accepted name lines up with its company.
//
// Corporate-suffix variants ("Evertune AI" vs "Evertune") deliberately do NOT
// merge: stripping those would fold genuinely different companies together
// ("Scale" and "Scale AI"), and a wrong merge suppresses something the user
// never declined — worse than a wrong split, which only costs a repeat question.
export function suggestionKey(name: string): string {
  return slugify(stripNameQualifier(name));
}

// Record a freshly-searched batch. Verdict stays null until the user answers —
// an unanswered batch is on screen, neither added nor declined.
export async function recordSuggestions(args: {
  userId: string;
  runId?: string;
  sessionId?: string;
  suggestions: SuggestionToRecord[];
}): Promise<void> {
  if (args.suggestions.length === 0) return;
  await prisma.companySuggestion.createMany({
    data: args.suggestions.map((s) => ({
      userId: args.userId,
      name: s.name,
      nameKey: suggestionKey(s.name),
      reason: s.reason,
      url: s.url ?? null,
      runId: args.runId ?? null,
      sessionId: args.sessionId ?? null,
    })),
  });
}

export type SuggestionDecision = {
  name: string;
  verdict: CompanySuggestionVerdict;
  declineReason?: CompanySuggestionDeclineReason;
  declineNote?: string;
};

// Write the user's answers onto the most recent undecided row per name.
//
// Matching on nameKey rather than an id because the widget round-trips names,
// not row ids — the payload is what the user sees and it predates this table.
// A decision with no matching row (a hand-typed name, a replayed old widget)
// is inserted so the signal still lands.
export async function settleSuggestions(args: {
  userId: string;
  runId?: string;
  sessionId?: string;
  decisions: SuggestionDecision[];
}): Promise<void> {
  if (args.decisions.length === 0) return;
  const decidedAt = new Date();
  const byKey = new Map(
    args.decisions.map((d) => [suggestionKey(d.name), d] as const),
  );

  const open = await prisma.companySuggestion.findMany({
    where: {
      userId: args.userId,
      verdict: null,
      nameKey: { in: [...byKey.keys()] },
    },
    select: { id: true, nameKey: true },
    orderBy: { createdAt: "desc" },
  });

  // One row per name — the newest open one. Older duplicates stay open and are
  // superseded by this decision the next time they'd be read.
  const targetByKey = new Map<string, string>();
  for (const row of open) {
    if (!targetByKey.has(row.nameKey)) targetByKey.set(row.nameKey, row.id);
  }

  // Grouped so the write is a fixed number of statements: one updateMany per
  // distinct (verdict, reason, note) shape, which in practice is a handful.
  const groups = new Map<string, { ids: string[]; d: SuggestionDecision }>();
  const missing: SuggestionDecision[] = [];
  for (const [key, d] of byKey) {
    const id = targetByKey.get(key);
    if (!id) {
      missing.push(d);
      continue;
    }
    const shape = `${d.verdict}|${d.declineReason ?? ""}|${d.declineNote ?? ""}`;
    const g = groups.get(shape) ?? { ids: [], d };
    g.ids.push(id);
    groups.set(shape, g);
  }

  await prisma.$transaction([
    ...[...groups.values()].map(({ ids, d }) =>
      prisma.companySuggestion.updateMany({
        where: { id: { in: ids } },
        data: {
          verdict: d.verdict,
          declineReason: d.declineReason ?? null,
          declineNote: d.declineNote ?? null,
          decidedAt,
        },
      }),
    ),
    ...(missing.length > 0
      ? [
          prisma.companySuggestion.createMany({
            data: missing.map((d) => ({
              userId: args.userId,
              name: d.name,
              nameKey: suggestionKey(d.name),
              reason: "(decided outside a search batch)",
              verdict: d.verdict,
              declineReason: d.declineReason ?? null,
              declineNote: d.declineNote ?? null,
              runId: args.runId ?? null,
              sessionId: args.sessionId ?? null,
              decidedAt,
            })),
          }),
        ]
      : []),
  ]);
}

// How far back the search is told about. Old enough that a repeated pattern is
// visible, bounded so the prompt doesn't grow without limit.
const HISTORY_LIMIT = 120;

// Everything the user has already ruled on, newest first — the search's memory
// of its own past proposals.
export async function listSuggestionHistory(
  userId: string,
): Promise<SuggestionHistoryEntry[]> {
  const rows = await prisma.companySuggestion.findMany({
    where: { userId, verdict: { not: null } },
    orderBy: { decidedAt: "desc" },
    take: HISTORY_LIMIT,
    select: {
      name: true,
      nameKey: true,
      verdict: true,
      declineReason: true,
      declineNote: true,
      decidedAt: true,
      runId: true,
    },
  });
  if (rows.length === 0) return [];

  // "The latest round" is the most recent runId that produced a decision. A
  // null runId (a replayed or hand-driven decision) never counts as the latest
  // round, since it can't be told apart from any other.
  const latestRunId = rows.find((r) => r.runId)?.runId ?? null;

  const byKey = new Map<string, SuggestionHistoryEntry>();
  for (const r of rows) {
    const declined = r.verdict === CompanySuggestionVerdict.DECLINED;
    const existing = byKey.get(r.nameKey);
    if (existing) {
      // Rows are newest-first, so the first one seen is the current verdict;
      // later ones only add to the decline count.
      if (declined) existing.timesDeclined += 1;
      continue;
    }
    byKey.set(r.nameKey, {
      name: r.name,
      nameKey: r.nameKey,
      verdict: r.verdict!,
      ...(declined && declineWhy(r) ? { why: declineWhy(r)! } : {}),
      timesDeclined: declined ? 1 : 0,
      lastDecidedAt: r.decidedAt ?? new Date(0),
      inLatestRound:
        declined && latestRunId !== null && r.runId === latestRunId,
    });
  }
  return [...byKey.values()];
}

function declineWhy(row: {
  declineReason: CompanySuggestionDeclineReason | null;
  declineNote: string | null;
}): string | null {
  const label = row.declineReason
    ? SUGGESTION_DECLINE_LABELS[row.declineReason]
    : null;
  const note = row.declineNote?.trim();
  if (label && note) return `${label} — ${note}`;
  return note ?? label ?? null;
}
