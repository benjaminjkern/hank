// The question that closes a finished add: move on, or keep hunting.
//
// Growing the watchlist is a step, not a destination, so the primary action is
// LEAVING it — "Done adding" hands off to the what's-next picker, and finding
// more is the secondary. A card whose main button is "Add more" reads as an
// invitation to stay in add-mode indefinitely, which is the opposite of what
// finishing an add means.
//
// Both paths that finish an add call it: the discovery commit, and the
// disambiguation tail when a name collided. It is NOT emitted while a
// disambiguation picker is still unanswered — that would stack two questions.
//
// `passedCount` rides along so the submission can report whether this round
// decided anything at all, which is what gates the session wrap on "Done".

import type { TurnEvent } from "@/server/agent/contracts";

import { persistWidget, type WatchlistAddArgs } from "./persistWidget";

export async function* promptAddMoreCompanies(
  added: string[],
  passedCount: number,
  args: WatchlistAddArgs,
): AsyncGenerator<TurnEvent> {
  yield* persistWidget(args, "add_more_companies", {
    addedThisBatch: added,
    passedCount,
  });
}
