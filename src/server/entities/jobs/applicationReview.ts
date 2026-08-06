// What the application critic concluded, and what it couldn't fix on its own.
//
// The revision loop can reword the page; it cannot answer a question about the
// person. "The letter says this venture ended, the resume lists it as current"
// is settled by the user knowing which is true — so when the loop stops with
// findings still open, they're kept here instead of discarded, and the page has
// something to show. Only BLOCKING findings survive: a polish note that outlived
// two rewrites is a matter of taste, not a thing to hold a submit on.
//
// A finding is attached to the item it's about, so editing that item drops it —
// the objection was to text that no longer exists. That's also why nothing here
// is a "resolved" flag: the finding is gone or it isn't.

import type { Prisma } from "@/generated/prisma/client";

// What the last review pass concluded. "clean" is a real verdict from a real
// pass, distinct from a null review (nothing has looked at this yet) and from
// "error" (we tried and couldn't).
export type ReviewOutcome = "clean" | "unresolved" | "error";

export type ReviewFinding = {
  // COVER_LETTER_ID or a questionId — the same ids the panel and the agent's
  // tools address items by.
  itemId: string;
  // The item as it was labelled when the finding was raised, so an entry stays
  // readable even if the question later leaves the form.
  label: string;
  // The critic's user-facing wording (its `userNote`), shown verbatim.
  note: string;
};

// There is deliberately no timestamp here. "Is this verdict still about the text
// on the page?" is answered by whether any item diverges from what the drafter
// last wrote (see `reviewState`) — the review is written at the end of that same
// pass, so that baseline IS the high-water mark, and a stored time would be a
// second, weaker way to ask the same question.
export type ApplicationReview = {
  outcome: ReviewOutcome;
  open: ReviewFinding[];
  // Findings the user answered by rewriting the item, held until the relay
  // carries them to Hank. A rewrite prompted by a specific objection says more
  // than the diff alone — "they were asked whether that venture is still
  // running, and this is how they put it" — and that's what the consolidation
  // pass turns into something the next draft won't get wrong.
  settled: ReviewFinding[];
};

export function readApplicationReview(
  raw: Prisma.JsonValue | null,
): ApplicationReview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const outcome =
    obj.outcome === "clean" || obj.outcome === "error"
      ? obj.outcome
      : "unresolved";
  return {
    outcome,
    open: readFindings(obj.open),
    settled: readFindings(obj.settled),
  };
}

function readFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): ReviewFinding[] => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return [];
    const rec = e as Record<string, unknown>;
    return typeof rec.itemId === "string" &&
      typeof rec.label === "string" &&
      typeof rec.note === "string"
      ? [{ itemId: rec.itemId, label: rec.label, note: rec.note }]
      : [];
  });
}

// How the review reads to a person, once the user's own edits are taken into
// account. Two of these five are states a stored `outcome` can't express, and
// both exist to stop a verdict outliving the text it was about:
//   settled — it stopped with findings open, and the user has since rewritten
//             every item it named. Nothing outstanding, nothing re-approved.
//   stale   — it came back clean, but the page has changed since. Still saying
//             "nothing came up" would be a claim about text nobody has read.
export type ReviewState = "clean" | "open" | "settled" | "stale" | "failed";

// `editedSince` is any item diverging from what the drafter last wrote — the
// review is written at the end of that same pass, so Hank's baseline doubles as
// the review's high-water mark and no second timestamp comparison is needed.
export function reviewState(
  review: ApplicationReview,
  editedSince: boolean,
): ReviewState {
  if (review.outcome === "error") return "failed";
  if (review.open.length > 0) return "open";
  if (review.outcome !== "clean") return "settled";
  return editedSince ? "stale" : "clean";
}

export function findingsForItem(
  review: ApplicationReview | null,
  itemId: string,
): ReviewFinding[] {
  return (review?.open ?? []).filter((f) => f.itemId === itemId);
}

// Settle one item's findings: the text they objected to is gone, so they leave
// `open` — but they move to `settled` rather than vanishing, because "you asked
// about this and here's how I answered it" is the useful half. Returns the
// review to persist, or `undefined` when nothing changed.
export function clearFindingsForItem(
  review: ApplicationReview | null,
  itemId: string,
): ApplicationReview | undefined {
  if (!review || review.open.length === 0) return undefined;
  const settling = review.open.filter((f) => f.itemId === itemId);
  if (settling.length === 0) return undefined;
  return {
    ...review,
    open: review.open.filter((f) => f.itemId !== itemId),
    settled: [...review.settled, ...settling],
  };
}

// Drop the settled findings the relay just carried, so they report once.
export function drainSettledFindings(
  review: ApplicationReview | null,
): ApplicationReview | undefined {
  if (!review || review.settled.length === 0) return undefined;
  return { ...review, settled: [] };
}
