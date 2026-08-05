// The shortlist board view — every role a round is still deciding at one
// company, grouped by stance, each row carrying the rationale its deciding pass
// wrote. Feeds the panel's board screen (GET /api/companies/[id]/shortlist-board),
// Hank's board context block, and the show_shortlist_board tool.
//
// The stance columns this reads are written elsewhere: the seed
// (procedures/registry/shortlist), the edit paths (setProposedStance), and the
// commit that clears them (entities/companies/commitShortlist).

import {
  CompanyEventType,
  JobEventType,
  JobInteractionStatus,
  ProposedBy,
  ProposedVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  isPending,
  placedVerdict,
  STANCE_WORDS,
  type PlaceableRow,
} from "@/server/entities/jobs/boardStance";
import {
  CONSIDERED_STATUSES,
  isStanceable,
} from "@/server/entities/jobs/shortlistPool";

export type ShortlistBoardTier =
  // The negotiation (pool rows, by PLACEMENT — see placementVerdict: a row the
  // user just re-marked stays in its old group until their next message):
  | "picks" // apply to these
  | "borderline" // worth a look; not recommended
  | "pass" // recommend against; closes at commit
  | "undecided" // on the board with no stance — nobody has called it yet
  // Still in the running, just not part of this round's ranking:
  | "notReadYet" // NEW — surfaced but the body was never read
  | "onHold" // deliberately deferred for a reason of its own
  // Decided by the passes that BUILT this board — shown so the automatic
  // filtering is auditable while the round is still open:
  | "filteredThisRound";

// Render order (also the collapse order — the UI opens the decision groups and
// collapses the two tails).
export const SHORTLIST_BOARD_TIERS: ShortlistBoardTier[] = [
  "picks",
  "borderline",
  "pass",
  "undecided",
  "notReadYet",
  "onHold",
  "filteredThisRound",
];

// When the round that produced the current board began. Closes at or after it
// are this round's automatic filtering; older ones belong to rounds the user
// already worked through, so they stay off the board.
//
// The board pull is the natural start (prescan runs on what the scrape just
// brought in), and a commit ends a round — so whichever is later wins. Null
// when the company has never been scraped: nothing to anchor on, so nothing
// closed is shown.
async function roundStartedAt(
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

export type ShortlistBoardRow = {
  jobId: string;
  jobSlug: string | null;
  title: string;
  location: string | null;
  compensation: string | null;
  employmentType: string | null;
  sourceUrl: string | null;
  status: JobInteractionStatus;
  // The scan pass's original read — shown as a secondary line on pool rows so
  // the negotiated stance and the machine's prior stay distinguishable.
  matchBucket: string | null;
  matchReason: string | null;
  // The one-line rationale for the row: the stance reason while a negotiation
  // is open, otherwise the deferNote a commit left on a set-aside role.
  reason: string | null;
  // The LIVE stance — what the panel shows selected. Null = undecided.
  // Distinct from the row's tier, which follows `placementVerdict`.
  verdict: ProposedVerdict | null;
  // The user re-marked this row and hasn't sent a message yet, so it's drawn
  // under its old group with the new mark selected.
  pending: boolean;
  // Who last set the stance.
  proposedBy: ProposedBy | null;
  // Whether the panel offers the stance buttons on this row.
  stanceable: boolean;
};

export type ShortlistBoardTierRows = {
  tier: ShortlistBoardTier;
  rows: ShortlistBoardRow[];
};

export type ShortlistBoardView = {
  companyId: string;
  companyName: string;
  companySlug: string | null;
  // A negotiation is open: some row is on the board (stanced or placed).
  // Derived, never stored.
  open: boolean;
  // Some row carries an unrelayed user mark — the panel says so, and the next
  // message is what settles them.
  pendingEdits: number;
  tiers: ShortlistBoardTierRows[];
};

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
  const roundStart = await roundStartedAt(userId, companyId);
  const closedThisRound = roundStart
    ? await prisma.jobEvent.findMany({
        where: {
          type: JobEventType.CLOSED,
          occurredAt: { gte: roundStart },
          jobInteraction: { userId, job: { companyId } },
        },
        select: { jobInteraction: { select: { jobId: true } } },
      })
    : [];
  const closedJobIds = [
    ...new Set(closedThisRound.map((e) => e.jobInteraction.jobId)),
  ];

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
      proposedVerdict: true,
      placementVerdict: true,
      proposedReason: true,
      proposedBy: true,
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
    orderBy: { updatedAt: "desc" },
  });

  // A proposal is on the table iff some row carries a stance. Committing clears
  // them all, which is what CLOSES the board: nothing is editable afterwards,
  // because the decision has been made and re-opening it is a fresh round.
  const open = rows.some(
    (r) => r.proposedVerdict !== null || r.placementVerdict !== null,
  );

  const byTier = new Map<ShortlistBoardTier, ShortlistBoardRow[]>();
  let pendingEdits = 0;
  for (const r of rows) {
    const tier = tierFor(r);
    const onBoard = r.proposedVerdict !== null || r.placementVerdict !== null;
    const pending = isPending(r);

    if (pending) pendingEdits++;
    const reason =
      r.status === JobInteractionStatus.CLOSED
        ? r.closeNote
        : onBoard
          ? r.proposedReason
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
      matchBucket: r.matchBucket,
      matchReason: r.matchReason,
      reason,
      verdict: r.proposedVerdict,
      pending,
      proposedBy: onBoard ? r.proposedBy : null,
      // Only while a proposal is open: a committed board is a record, not a
      // working surface. Changing a decided role is a conversation with Hank
      // ("actually, close that one"), not a click here.
      stanceable: open && isStanceable(r.status),
    });
    byTier.set(tier, list);
  }

  return {
    companyId: company.id,
    companyName: company.name,
    companySlug: company.slug,
    open,
    pendingEdits,
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
          : row.proposedBy === ProposedBy.USER
            ? "set by the user"
            : null,
      ].filter(Boolean);
      lines.push(
        `  - ${row.title}${bits.length ? ` (${bits.join(", ")})` : ""}${row.reason ? ` — ${row.reason}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
