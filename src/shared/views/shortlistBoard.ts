// The shortlist board's payload — every role a round is still deciding at one
// company, grouped by stance, each row carrying the rationale its deciding pass
// wrote. Built by loadShortlistBoard (server/views/shortlistBoard.ts).

import type {
  JobInteractionStatus,
  ProposedVerdict,
} from "@/shared/generated/enums";
import type { ShortlistBoardTier } from "@/shared/shortlistBoardTiers";
import type {
  NegotiationRow,
  NegotiationState,
} from "@/shared/views/negotiationPanel";

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
