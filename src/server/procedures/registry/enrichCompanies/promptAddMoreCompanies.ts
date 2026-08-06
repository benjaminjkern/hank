// The question that closes a finished add: keep hunting, or move on.
//
// Growing the watchlist is a step, not a destination, so something has to ask
// what's next — but asking it with the full what's-next picker answers a
// question the user didn't ask, listing companies and roles when they were
// mid-hunt. This asks the local question and lets "Done" fall through to that
// picker.
//
// Both paths that finish an add call it: the checklist submission, and the
// disambiguation tail when a name collided. It is NOT emitted while a
// disambiguation picker is still unanswered — that would stack two questions.

import type { TurnEvent } from "@/server/agent/contracts";

import { persistWidget, type WatchlistAddArgs } from "./persistWidget";

export async function* promptAddMoreCompanies(
  added: string[],
  args: WatchlistAddArgs,
): AsyncGenerator<TurnEvent> {
  yield* persistWidget(args, "add_more_companies", { addedThisBatch: added });
}
