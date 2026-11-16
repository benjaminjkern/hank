// The vocabulary of an application's written pieces: the stored short answer,
// whose words an item holds, what a user's unsent change did to it, and what the
// decider ruled for it. The rules that compute these (authorFor,
// applicationEditsFor, the decider itself) are server code in
// entities/jobs/applicationDrafts.ts and subagents/registry/applicationDecider.ts.

import type { WordDiff } from "@/shared/utils/diff";

export type ShortAnswer = { question: string; answer: string };

// Whose words an item currently holds. Nothing records this: the live text
// either matches what Hank wrote or it doesn't, and only his own writes move
// that baseline. So putting his wording back makes it his again — which is the
// honest answer, since it IS his again.
export type DraftAuthor = "hank" | "user";

export type ApplicationEdit = {
  itemId: string;
  // "Cover letter", or the question as the form asks it.
  label: string;
  // "wrote" — nothing was there; "revised" — Hank's version changed;
  // "cleared" — the user emptied it; "added" — the user described a question
  // the scrape missed, which is news even with no answer under it yet;
  // "removed" — they took one of their own back off the form.
  change: "wrote" | "revised" | "cleared" | "added" | "removed";
  diff: WordDiff;
};

// The decider's ruling on one form item: write it, leave it for the user to
// fill in on the real form, or hand it back because only they can answer it.
export type DraftVerdict = "draft" | "skip" | "ask_user";
