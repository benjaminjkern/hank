import { formatFocusRefToken } from "@/lib/focusRefToken";
import { yieldUiEvents } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { runCommitDiscovery } from "@/server/procedures/registry/commitDiscovery";
import { runFindCompanies } from "@/server/procedures/registry/findCompanies";
import {
  buildDiscoveryEvents,
  buildShowEvents,
} from "@/server/views/showEvents";

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
  entry: { direction?: string; append?: boolean },
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  const r = await runFindCompanies(entry, args);

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
  //
  // That pointer is a CHIP, not plain words: the list hangs off no entity and
  // sits in no menu, so once the user navigates the panel elsewhere this line in
  // their scrollback is the way back to it. Its label NAMES THE DESTINATION and
  // never the contents — the panel is a live singleton, so a chip reading "8
  // companies" would still say 8 next to a list that has since become 6, or
  // another batch entirely. The count belongs in the sentence, which is a
  // report of what just happened and stays true.
  //
  // The provenance sentence leads: how a batch was found is what separates a bad
  // search from a bad thesis, and the user can only judge that if they see it.
  const count = `${r.candidates.length} ${r.candidates.length === 1 ? "company" : "companies"}`;
  const chip = formatFocusRefToken("discovery", null, "Companies to add");
  const opener = r.provenance ? `${r.provenance.trim()} ` : "";
  yield {
    type: "text",
    text: `${opener}Put ${count} on ${chip} — they're all set to add, so uncheck any you don't want and send. Tell me what's off about them and I'll look again instead.`,
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
      text: "There's no company list on screen right now — say the word and I'll go find some.",
    };
    return { wrappedUp: false };
  }
  // The list is fully settled, so leaving it up would offer a surface with
  // nothing left to decide. Back to the dashboard, where the companies that
  // just landed are — same move the shortlist board makes on commit.
  yield* yieldUiEvents((await buildShowEvents(args.userId)).events);
  return { wrappedUp: false };
}
