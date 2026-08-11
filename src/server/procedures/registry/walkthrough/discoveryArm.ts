import { yieldUiEvents } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { runCommitDiscovery } from "@/server/procedures/registry/commitDiscovery";
import { runFindCompanies } from "@/server/procedures/registry/findCompanies";
import { buildDiscoveryEvents } from "@/server/views/showEvents";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// Find companies worth adding and put them on the discovery panel. Entered by
// the `find_companies` handoff; `direction` is Hank's free-text steer (absent =
// work from the user's thesis alone).
//
// Re-entry always searches. Candidates the user never marked aren't lost by
// that — they're carried into the search's own input and re-emitted when the new
// direction still supports them (entities/companies/companySuggestions.ts), so
// the list that comes back is the same names filtered against what the user just
// said rather than a replay of a batch they'd walked away from.
export async function* runDiscoveryArm(
  direction: string | undefined,
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  const r = await runFindCompanies({ direction }, args);

  // Both empty cases have to speak for themselves — a handoff already ended
  // Hank's turn, so there's no reply coming after this.
  if (r.reason === "no_basis" || r.reason === "failed") {
    yield {
      type: "text",
      text: "I couldn't put a search together just now. What kind of companies are you looking for — sector, stage, the shape of the role?",
    };
    return { wrappedUp: false };
  }
  if (r.reason === "none_found") {
    yield {
      type: "text",
      text: "I looked, but nothing new came up beyond what's already on your list. Want me to try a different angle — a different sector or stage, or casting wider?",
    };
    return { wrappedUp: false };
  }

  // The panel is the surface, so the only chat line is the pointer to it. The
  // names themselves are on screen and Hank is told not to re-list them.
  yield {
    type: "text",
    text: `Put ${r.candidates.length} ${r.candidates.length === 1 ? "company" : "companies"} on the right — mark the ones worth tracking and send when you're ready. Tell me what's off about them and I'll look again.`,
  };
  yield* yieldUiEvents((await buildDiscoveryEvents(args.userId)).events);
  return { wrappedUp: false };
}

// Settle the marks: add what's marked ADD, record what's marked PASS, and put
// the refreshed list back on screen. Entered by the `commit_discovery` handoff.
export async function* runDiscoveryCommitArm(
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  const result = yield* runCommitDiscovery(args);
  if (result.empty) {
    yield {
      type: "text",
      text: "Nothing's marked yet — tap Add or Pass on the ones you've got a view on, then send.",
    };
    return { wrappedUp: false };
  }
  // Refresh the panel so the settled rows drop into their tails rather than
  // sitting in the open list until something else repaints.
  yield* yieldUiEvents((await buildDiscoveryEvents(args.userId)).events);
  return { wrappedUp: false };
}
