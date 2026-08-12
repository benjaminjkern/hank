// The shortlist board's tier vocabulary — what groups a board has, in what
// order, and which of them a commit CLOSES.
//
// It lives in `lib/` because both sides need the same answer: the panel draws
// the groups, and the chat line that introduces a board has to tally them the
// same way (quoting the ranker's own count said "1 I'd pass on" beside a pile
// of forty, since the ranker never saw the roles the earlier passes had already
// ruled out). The board's payload loader is server code that opens a database
// connection, so a client component reaching in for this map pulled the Prisma
// runtime into the browser bundle and the whole dashboard route stopped
// compiling — a vocabulary two tiers share belongs in neither of them.

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

// Render order. The last two are the ones the panel collapses, and they're
// adjacent on purpose: together they are exactly what committing this board
// CLOSES. Everything above survives the commit in some form, which is why
// "not read yet" and "on hold" sit with the live groups rather than in the tail
// — they're still in play, they just haven't been ranked.
export const SHORTLIST_BOARD_TIERS: ShortlistBoardTier[] = [
  "picks",
  "borderline",
  "undecided",
  "notReadYet",
  "onHold",
  "pass",
  "filteredThisRound",
];

// The board renders TWO groups, and the line between them is what COMMITTING
// does: `keep` survives it, `discard` is closed by it.
export type BoardGroup = "keep" | "discard";

export const BOARD_GROUP_OF_TIER: Record<ShortlistBoardTier, BoardGroup> = {
  picks: "keep",
  borderline: "keep",
  undecided: "keep",
  notReadYet: "keep",
  onHold: "keep",
  pass: "discard",
  filteredThisRound: "discard",
};
