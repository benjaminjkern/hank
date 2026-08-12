// Predicates over an application item that BOTH the panel and the server read.
//
// They live here rather than beside the payload type in `server/views/application`
// because the panel is a client component: importing a value out of that module
// drags Prisma and `pg` into the browser bundle, and the build fails on `dns`
// /`fs`/`net`/`tls`. A type-only import erases; a function does not.
//
// The parameter is structural so this file needs nothing from the view but the
// two fields it reads.

import type { ApplicationEdit } from "@/server/entities/jobs/applicationDrafts";
import type { DraftVerdict } from "@/server/subagents/registry/applicationDecider";

// A form field nobody needs to draft and nobody has written in — a dropdown,
// a LinkedIn URL. Blank on purpose, so every surface that lists items has to
// treat it differently from a question still waiting on work: the page tucks
// these in a collapsed tail, and Hank gets them as one line rather than as a
// column of empty answers he reads as unfinished.
export function isStockItem(item: {
  verdict: DraftVerdict | null;
  text: string | null;
}): boolean {
  return item.verdict === "skip" && !item.text?.trim();
}

// Where the PAGE files an item, which is a different question from the one
// above: a row must not move under the cursor on the keystroke that changed it,
// so the two sections are decided by the text Hank last saw and only re-file
// once a message has relayed the change. Same rule the shortlist board groups
// by — draw a row where it was placed, not where the live value would put it.
//
// It differs from `isStockItem` only while the USER has an unsent change: when
// Hank writes, the write re-baselines, so the two agree and the item moves
// immediately — which is right, because he moved it and they watched him.
export function wasStockItem(item: {
  verdict: DraftVerdict | null;
  text: string | null;
  change: ApplicationEdit["change"] | null;
}): boolean {
  if (item.verdict !== "skip") return false;
  // What the baseline held, read off the verb for the change against it.
  const hadText =
    item.change === null
      ? !!item.text?.trim()
      : item.change === "revised" || item.change === "cleared";
  return !hadText;
}
