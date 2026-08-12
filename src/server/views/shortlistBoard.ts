// The shortlist board view — every role a round is still deciding at one
// company, grouped by stance, each row carrying the rationale its deciding pass
// wrote. Feeds the panel's board screen (GET /api/companies/[id]/shortlist-board),
// Hank's board context block, and the show_shortlist_board tool.
//
// The stance columns this reads are written elsewhere: the seed
// (procedures/registry/shortlist), the edit paths (setBoardStance), and the
// commit that clears them (entities/companies/commitShortlist).

import {
  MatchBucket,
  JobInteractionStatus,
  ProposedVerdict,
} from "@/generated/prisma/client";
import {
  BOARD_GROUP_OF_TIER,
  SHORTLIST_BOARD_TIERS,
  type ShortlistBoardTier,
} from "@/lib/shortlistBoardTiers";
import { prisma } from "@/server/db/prisma";
import {
  closedThisRoundJobIds,
  isOnBoard,
  isOverridden,
  isPending,
  liveVerdict,
  placedVerdict,
  STANCE_WORDS,
  type PlaceableRow,
} from "@/server/entities/jobs/boardStance";
import {
  canHoldStance,
  CONSIDERED_STATUSES,
} from "@/server/entities/jobs/shortlistPool";
import type {
  NegotiationRow,
  NegotiationState,
} from "@/server/views/negotiationPanel";

export type BoardCounts = {
  picked: number;
  borderline: number;
  // Everything the commit would close — the ranker's passes AND the roles the
  // earlier filtering ruled out. One number, because the board shows them as
  // one pile and the user reads them as one outcome.
  closing: number;
  total: number;
};

export function countBoard(board: ShortlistBoardView): BoardCounts {
  const count = (tier: ShortlistBoardTier) =>
    board.tiers.find((t) => t.tier === tier)?.rows.length ?? 0;
  const closing = board.tiers
    .filter((t) => BOARD_GROUP_OF_TIER[t.tier] === "discard")
    .reduce((sum, t) => sum + t.rows.length, 0);
  const total = board.tiers.reduce((sum, t) => sum + t.rows.length, 0);
  return {
    picked: count("picks"),
    borderline: count("borderline"),
    closing,
    total,
  };
}

export type ShortlistBoardRow = NegotiationRow & {
  jobId: string;
  jobSlug: string | null;
  title: string;
  location: string | null;
  compensation: string | null;
  employmentType: string | null;
  sourceUrl: string | null;
  status: JobInteractionStatus;
  // The one-line rationale for the row: the stance reason while a negotiation
  // is open, otherwise the deferNote a commit left on a set-aside role.
  reason: string | null;
  // The scan pass's read, ONLY when it contradicts where the row ended up.
  // Null on the ordinary agreeing row — the shortlist reason is written later
  // and with more context, so repeating the earlier one just doubles the row.
  scanDissent: string | null;
  // The LIVE stance — what the panel shows selected. Null = undecided.
  // Distinct from the row's tier, which follows `placementVerdict`.
  verdict: ProposedVerdict | null;
  // Hank's proposal, populated ONLY where the user overruled it — so the
  // disagreement is visible without labelling every untouched row "Hank:".
  overriddenAgentVerdict: ProposedVerdict | null;
  overriddenAgentReason: string | null;
  // Whether the panel offers the three marks on this row. Wider than
  // `isStanceable`, deliberately: a row the filtering closed can be marked too,
  // and the mark revives it on the way (see runReconsiderJob). The entity
  // predicate stays narrow because a CLOSED row genuinely cannot hold a stance
  // until something un-closes it.
  markable: boolean;
};

export type ShortlistBoardTierRows = {
  tier: ShortlistBoardTier;
  rows: ShortlistBoardRow[];
};

// `open` is derived, never stored: some row is on the board (stanced or
// placed). `openThreadCount` is always 0 — every row arrives with a mark
// already selected, so there is no row waiting on an answer, only rows waiting
// on agreement.
export type ShortlistBoardView = NegotiationState & {
  companyId: string;
  companyName: string;
  companySlug: string | null;
  tiers: ShortlistBoardTierRows[];
};

// The first read only earns a line when it genuinely contradicts the stance —
// two steps apart on the same axis. A POSSIBLE bucket contradicts nothing, and
// one step (STRONG demoted to borderline) is ordinary re-ranking, not a
// disagreement worth a second line on every row.
function scanDissent(
  bucket: MatchBucket | null,
  verdict: ProposedVerdict | null,
): string | null {
  if (!bucket || !verdict) return null;
  if (bucket === MatchBucket.STRONG && verdict === ProposedVerdict.PASS) {
    return "The first read called this a strong match.";
  }
  if (bucket === MatchBucket.WEAK && verdict === ProposedVerdict.PICK) {
    return "The first read called this a stretch.";
  }
  return null;
}

function tierFor(row: PlaceableRow): ShortlistBoardTier {
  if (row.status === JobInteractionStatus.CLOSED) return "filteredThisRound";
  // The board groups by DECISION, not by how much is known about the role: a
  // still-unread role someone marked belongs with the other roles carrying that
  // mark, or the proposal reads as if it were never made.
  const placed = placedVerdict(row);
  if (placed === ProposedVerdict.PICK) return "picks";
  if (placed === ProposedVerdict.BORDERLINE) return "borderline";
  if (placed === ProposedVerdict.PASS) return "pass";
  if (row.status === JobInteractionStatus.NEW) return "notReadYet";
  // A defer with a reason of its own is the user parking a role deliberately —
  // distinct from this round's "outranked", which IS the borderline group.
  if (row.status === JobInteractionStatus.DEFERRED) return "onHold";
  return "undecided";
}

export async function loadShortlistBoard(
  userId: string,
  companyId: string,
): Promise<ShortlistBoardView | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, slug: true },
  });
  if (!company) return null;

  // This round's automatic closes, resolved to job ids first so the row query
  // stays bounded: a company worked for months carries hundreds of closes and
  // the board only ever wants the current round's.
  const closedJobIds = await closedThisRoundJobIds(userId, companyId);

  const rows = await prisma.jobInteraction.findMany({
    // Considered roles, plus this round's closes. Skipping the decided tail in
    // the QUERY keeps a long-worked company cheap to load (a board showing 30
    // live roles shouldn't read 220 rows to find them).
    where: {
      userId,
      job: { companyId },
      OR: [
        { status: { in: CONSIDERED_STATUSES } },
        {
          status: JobInteractionStatus.CLOSED,
          jobId: { in: closedJobIds },
        },
      ],
    },
    select: {
      status: true,
      agentVerdict: true,
      agentReason: true,
      userVerdict: true,
      placementVerdict: true,
      deferReason: true,
      deferNote: true,
      closeNote: true,
      matchBucket: true,
      matchReason: true,
      updatedAt: true,
      job: {
        select: {
          id: true,
          slug: true,
          title: true,
          locationAndArrangement: true,
          compensation: true,
          employmentType: true,
          sourceUrl: true,
        },
      },
    },
    // Strongest read first, then alphabetical — and NOTHING here may derive from
    // a write timestamp. `updatedAt` is `@updatedAt`, so ordering by it made
    // every mark bump its own row to the top of the group: the button moved out
    // from under the cursor the instant it was pressed.
    orderBy: [
      { matchBucket: { sort: "asc", nulls: "last" } },
      { matchScore: { sort: "desc", nulls: "last" } },
      { job: { title: "asc" } },
    ],
  });

  // A proposal is on the table iff some row carries a stance. Committing clears
  // them all, which is what CLOSES the board: nothing is editable afterwards,
  // because the decision has been made and re-opening it is a fresh round.
  const open = rows.some(isOnBoard);

  const byTier = new Map<ShortlistBoardTier, ShortlistBoardRow[]>();
  let pendingCount = 0;
  for (const r of rows) {
    const tier = tierFor(r);
    const onBoard = isOnBoard(r);
    const pending = isPending(r);

    if (pending) pendingCount++;
    // On an overridden row the rationale moves to `overriddenAgentReason`, which
    // renders it attributed to Hank. Leaving it here too printed one string
    // twice — the plain line and "Hank had this as X — <same string>".
    const overridden = isOverridden(r);
    const reason =
      r.status === JobInteractionStatus.CLOSED
        ? r.closeNote
        : overridden
          ? null
          : onBoard
            ? r.agentReason
            : r.status === JobInteractionStatus.DEFERRED
              ? r.deferNote
              : null;
    const list = byTier.get(tier) ?? [];
    list.push({
      jobId: r.job.id,
      jobSlug: r.job.slug,
      title: r.job.title,
      location: r.job.locationAndArrangement,
      compensation: r.job.compensation,
      employmentType: r.job.employmentType,
      sourceUrl: r.job.sourceUrl,
      status: r.status,
      // Only when the first read CONTRADICTS where the row ended up. Agreement
      // is the boring case and repeating it doubles every row.
      scanDissent: scanDissent(r.matchBucket, liveVerdict(r)),
      reason,
      verdict: liveVerdict(r),
      // Hank's side, shown only when the user has overruled him — on an
      // untouched row his reason IS the row's reason, above.
      overriddenAgentVerdict: overridden ? r.agentVerdict : null,
      overriddenAgentReason: overridden ? r.agentReason : null,
      pending,
      // Only while a proposal is open: a committed board is a record, not a
      // working surface. Changing a decided role is a conversation with Hank
      // ("actually, close that one"), not a click here. This round's filtered
      // rows are included — correcting the filtering is the point of showing
      // it, and committing closes that door with the rest of the board.
      markable: open && canHoldStance(r.status),
    });
    byTier.set(tier, list);
  }

  return {
    companyId: company.id,
    companyName: company.name,
    companySlug: company.slug,
    open,
    pendingCount,
    openThreadCount: 0,
    tiers: SHORTLIST_BOARD_TIERS.flatMap((tier) => {
      const tierRows = byTier.get(tier);
      return tierRows ? [{ tier, rows: tierRows }] : [];
    }),
  };
}

const TIER_LABELS: Record<ShortlistBoardTier, string> = {
  picks: "Picks",
  borderline: "Borderline",
  pass: "Recommended pass",
  undecided: "Undecided",
  notReadYet: "Not read yet",
  onHold: "On hold",
  filteredThisRound: "Filtered out this round",
};

// Agent-facing compact rendering — one line per role in the negotiation tiers,
// closed tiers as counts unless `full`. Shared by the show_shortlist_board tool
// and Hank's per-turn board context block so the two can't drift.
export function renderShortlistBoardText(
  board: ShortlistBoardView,
  opts?: { full?: boolean },
): string {
  // The four decision groups list their roles even in the compact rendering;
  // the two tails are counts unless asked for in full.
  const DECISION_TIERS: ShortlistBoardTier[] = [
    "picks",
    "borderline",
    "pass",
    "undecided",
  ];
  const lines: string[] = [
    `Shortlist board — ${board.companyName}${board.open ? " (negotiation open)" : ""}:`,
  ];
  for (const { tier, rows } of board.tiers) {
    const label = TIER_LABELS[tier];
    if (!opts?.full && !DECISION_TIERS.includes(tier)) {
      lines.push(
        `- ${label}: ${rows.length} role${rows.length === 1 ? "" : "s"}`,
      );
      continue;
    }
    lines.push(`- ${label}:`);
    for (const row of rows) {
      const bits = [
        row.jobSlug ? `slug ${row.jobSlug}` : null,
        row.location,
        // A pending row is drawn under its OLD group, so name the new mark
        // rather than letting the grouping imply a stance the user changed.
        row.pending
          ? `the user just marked this ${row.verdict ? STANCE_WORDS[row.verdict] : "undecided"}`
          : row.overriddenAgentVerdict
            ? `the user overruled your ${STANCE_WORDS[row.overriddenAgentVerdict]}`
            : null,
        row.scanDissent,
      ].filter(Boolean);
      lines.push(
        `  - ${row.title}${bits.length ? ` (${bits.join(", ")})` : ""}${row.reason ? ` — ${row.reason}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
