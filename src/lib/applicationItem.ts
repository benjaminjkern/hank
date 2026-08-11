// Predicates over an application item that BOTH the panel and the server read.
//
// They live here rather than beside the payload type in `server/views/application`
// because the panel is a client component: importing a value out of that module
// drags Prisma and `pg` into the browser bundle, and the build fails on `dns`
// /`fs`/`net`/`tls`. A type-only import erases; a function does not.
//
// The parameter is structural so this file needs nothing from the view but the
// two fields it reads.

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
