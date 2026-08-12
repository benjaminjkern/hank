// What the company search has proposed, and what the user did with it.
//
// Discovery's analogue of the board's stance columns: the record that makes a
// correction durable instead of a lost checkbox. A batch is written when it's
// rendered, settled when the user answers, and read back into the NEXT search's
// input — which is the whole loop.
//
// A row's verdict answers a different question depending on which state it's in,
// and both halves feed the next search:
//   - DECLINED / ADDED — the user answered. History: read as advice, not a
//     filter, so a later direction can reopen ground a past decline closed
//     without any un-decline mechanism existing.
//   - null — the user never answered (they typed past the card). STILL ON THE
//     TABLE: fed back so the search can re-emit the ones the new direction
//     supports. This is why walking away from a checklist costs nothing.
//
// A decline is a bare bit — the name, and that's all. The reason a batch was
// wrong is a sentence in chat, which reaches the search as its `direction` and
// reaches memory through the ordinary consolidation pass; per-name reason codes
// were a lossy re-encoding of it.

import { CompanySuggestionVerdict } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { slugify } from "@/server/platform/slug/slugify";
import { nowMs } from "@/utils/now";

export type SuggestionToRecord = {
  name: string;
  reason: string;
  // What the search established about the company, a few sentences. Absent when
  // nothing wrote one — a row Hank put on the list himself did no searching.
  summary?: string;
  url?: string;
};

// Which open rows are the batch ON SCREEN: the ones from the run that produced
// the newest of them. Both the panel's loader and every write that has to land
// "on the current list" go through this, so a row Hank adds can't miss the list
// the user is looking at.
//
// A null runId (a hand-driven or replayed write) can't be told apart from any
// other, so those rows only ever form a batch among themselves.
export function currentBatch<T extends { runId: string | null }>(
  openRowsNewestFirst: T[],
): T[] {
  const newest = openRowsNewestFirst[0];
  if (!newest) return [];
  return openRowsNewestFirst.filter((r) =>
    newest.runId === null ? r.runId === null : r.runId === newest.runId,
  );
}

// One name's history as the search reads it. Counts and dates are here so the
// prompt can weigh a repeated recent decline differently from a lone stale one
// — the "fade" is the model's judgment, not a cutoff in code.
export type SuggestionHistoryEntry = {
  name: string;
  nameKey: string;
  verdict: CompanySuggestionVerdict;
  timesDeclined: number;
  lastDecidedAt: Date;
  // Declined in the most recent answered round — the one case the search is
  // told never to re-propose unless this run's direction names it.
  inLatestRound: boolean;
};

// A candidate the user was shown and never answered. Carries the search's own
// case for it so a carried-forward name arrives with the same context it had
// the first time.
export type OpenSuggestion = {
  name: string;
  reason: string;
  url?: string;
  proposedAt: Date;
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
//
// A name carried forward from a batch the user typed past is REPLACED rather
// than duplicated — the stale open row is dropped and re-inserted with this
// run's reason and date. Nothing references a suggestion row by id, so
// delete-then-insert keeps it to two statements flat in N, and moving the
// proposal date forward is what holds a still-believed-in candidate inside the
// freshness window while one the search stops emitting ages out.
//
// `append` decides whether this is a NEW list or more of the one on screen, and
// it's a runId question rather than a delete: the panel draws one run, so
// writing under the open batch's runId puts these rows beside it and writing
// under this run's starts a fresh one. Appending onto nothing is just a new
// batch.
export async function recordSuggestions(args: {
  userId: string;
  runId?: string;
  sessionId?: string;
  append?: boolean;
  suggestions: SuggestionToRecord[];
}): Promise<void> {
  if (args.suggestions.length === 0) return;
  const byKey = new Map(
    args.suggestions.map((s) => [suggestionKey(s.name), s] as const),
  );
  const runId = args.append
    ? ((await openBatchRunId(args.userId)) ?? args.runId ?? null)
    : (args.runId ?? null);

  await prisma.$transaction(async (tx) => {
    await tx.companySuggestion.deleteMany({
      where: {
        userId: args.userId,
        verdict: null,
        nameKey: { in: [...byKey.keys()] },
      },
    });
    await tx.companySuggestion.createMany({
      data: [...byKey.entries()].map(([nameKey, s]) => ({
        userId: args.userId,
        name: s.name,
        nameKey,
        reason: s.reason,
        summary: s.summary ?? null,
        url: s.url ?? null,
        runId,
        sessionId: args.sessionId ?? null,
      })),
    });
  });
}

// The runId of the batch on screen, or null when nothing is open. Null is also
// what a batch of hand-driven rows reports, which is correct: they group with
// each other and with nothing else.
export async function openBatchRunId(userId: string): Promise<string | null> {
  const newest = await prisma.companySuggestion.findFirst({
    where: { userId, verdict: null },
    orderBy: { createdAt: "desc" },
    select: { runId: true },
  });
  return newest?.runId ?? null;
}

export type SuggestionDecision = {
  name: string;
  verdict: CompanySuggestionVerdict;
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
  // distinct verdict, which is at most two.
  const groups = new Map<string, string[]>();
  const missing: SuggestionDecision[] = [];
  for (const [key, d] of byKey) {
    const id = targetByKey.get(key);
    if (!id) {
      missing.push(d);
      continue;
    }
    groups.set(d.verdict, [...(groups.get(d.verdict) ?? []), id]);
  }

  await prisma.$transaction([
    ...[...groups.entries()].map(([verdict, ids]) =>
      prisma.companySuggestion.updateMany({
        where: { id: { in: ids } },
        data: { verdict: verdict as CompanySuggestionVerdict, decidedAt },
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
      timesDeclined: declined ? 1 : 0,
      lastDecidedAt: r.decidedAt ?? new Date(0),
      inLatestRound:
        declined && latestRunId !== null && r.runId === latestRunId,
    });
  }
  return [...byKey.values()];
}

// How long a name the user never answered stays on the table. Long enough to
// carry a discovery session across a few days; short enough that a list they
// walked away from last month doesn't come back with a search they've forgotten
// about. The date moves forward every time the search re-emits the name.
const OPEN_POOL_DAYS = 7;
const OPEN_POOL_LIMIT = 40;

// Candidates the user was shown and never answered, newest first. Fed back into
// the next search so a checklist that got typed past isn't lost work.
export async function listOpenSuggestions(
  userId: string,
): Promise<OpenSuggestion[]> {
  const since = new Date(nowMs() - OPEN_POOL_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.companySuggestion.findMany({
    where: { userId, verdict: null, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: OPEN_POOL_LIMIT,
    select: {
      name: true,
      nameKey: true,
      reason: true,
      url: true,
      createdAt: true,
    },
  });

  // Newest row wins per name. recordSuggestions keeps this to one row per open
  // name, so a duplicate here means a row predating that — still worth folding.
  const byKey = new Map<string, OpenSuggestion>();
  for (const r of rows) {
    if (byKey.has(r.nameKey)) continue;
    byKey.set(r.nameKey, {
      name: r.name,
      reason: r.reason,
      ...(r.url ? { url: r.url } : {}),
      proposedAt: r.createdAt,
    });
  }
  return [...byKey.values()];
}
