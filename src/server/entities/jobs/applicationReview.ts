// What the application critic concluded, and what it couldn't fix on its own.
//
// The revision loop can reword the page; it cannot answer a question about the
// person. "The letter says this venture ended, the resume lists it as current"
// is settled by the user knowing which is true — so when the loop stops with
// findings still open, they're kept here instead of discarded, and the page has
// something to show. Only BLOCKING findings survive: a polish note that outlived
// two rewrites is a matter of taste, not a thing to hold a submit on.
//
// A finding is attached to the exact WORDS it objects to, by a hash of them
// (`atHash`). Nothing marks one resolved and no write clears one: it stands
// while those words are on the page and settles when they aren't. Anchoring to
// the item instead — clear-on-edit — settled a finding the moment the item was
// touched, so editing and undoing reported two live objections as answered.

import type { Prisma } from "@/generated/prisma/client";
import { fnv1a } from "@/utils/hash";
import { normalizeForCompare } from "@/utils/text";

export type ReviewFinding = {
  // COVER_LETTER_ID or a questionId — the same ids the panel and the agent's
  // tools address items by.
  itemId: string;
  // The item as it was labelled when the finding was raised, so an entry stays
  // readable even if the question later leaves the form.
  label: string;
  // The critic's user-facing wording (its `userNote`), shown verbatim.
  note: string;
  // The item's text when this was raised, hashed. Compare it to what's there
  // now: equal ⇒ the objection is still about what's on the page.
  atHash: string;
};

// One item's text, as the hash is taken over it. Whitespace-insensitive so a
// reflow doesn't read as a rewrite.
export function findingAnchor(text: string | null | undefined): string {
  return fnv1a(normalizeForCompare(text ?? ""));
}

// The findings and nothing else — no verdict word and no timestamp. Both would
// be second, weaker ways to ask what the findings already answer: whether a
// finding is still about the text on the page is decided by comparing the words,
// and "how did the pass end" is a fact about ONE pass that the row outlives (a
// drained finding left a stored "unresolved" standing over an empty list). The
// pass reports its own ending to whoever ran it — see CritiqueStop.
export type ApplicationReview = {
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
  return {
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
      typeof rec.note === "string" &&
      typeof rec.atHash === "string"
      ? [
          {
            itemId: rec.itemId,
            label: rec.label,
            note: rec.note,
            atHash: rec.atHash,
          },
        ]
      : [];
  });
}

// Split the stored findings by whether the words they objected to are still on
// the page. Nothing persists this: it's re-derived from the current text every
// time, which is what makes an edit-then-undo a no-op rather than a settlement.
export function partitionFindings(
  review: ApplicationReview | null,
  textForItem: (itemId: string) => string | null,
): { open: ReviewFinding[]; settled: ReviewFinding[] } {
  const open: ReviewFinding[] = [];
  const settled: ReviewFinding[] = [];
  for (const f of review?.open ?? []) {
    (findingAnchor(textForItem(f.itemId)) === f.atHash ? open : settled).push(
      f,
    );
  }
  // Anything already banked as settled by an earlier pass stays settled.
  settled.push(...(review?.settled ?? []));
  return { open, settled };
}

// Drop the findings the relay just carried, so they report once. Settling is
// derived, so this takes the split rather than recomputing it: the entries whose
// words are gone leave `open` for good, and anything banked earlier clears.
export function drainSettledFindings(
  review: ApplicationReview | null,
  settled: ReviewFinding[],
): ApplicationReview | undefined {
  if (!review || settled.length === 0) return undefined;
  const spent = new Set(settled.map((f) => `${f.itemId}\u0000${f.atHash}`));
  return {
    ...review,
    open: review.open.filter((f) => !spent.has(`${f.itemId}\u0000${f.atHash}`)),
    settled: [],
  };
}
