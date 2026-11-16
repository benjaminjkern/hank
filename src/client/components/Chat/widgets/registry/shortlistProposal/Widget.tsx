"use client";

// REPLAY-ONLY stub: nothing emits shortlist_proposal anymore — the shortlist
// board (right panel) replaced the sticky widget, and its commit is Hank's
// commit_shortlist. A pre-board session whose LAST message was a live proposal
// mounts this and gets nothing; re-entering the company seeds a board from the
// same SCANNED rows. Scrollback cards for old SUBMISSIONS still render via
// WidgetResponseCard; model replay of old proposal blocks still renders via
// this def's toText.
export function ShortlistProposalWidget() {
  return null;
}
