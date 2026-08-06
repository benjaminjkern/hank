import { widgetEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { runFindCompanies } from "@/server/procedures/registry/findCompanies";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// Find companies worth adding and put the checklist on screen. Entered by the
// `find_companies` handoff; `direction` is Hank's free-text steer (absent = work
// from the user's thesis alone).
//
// Re-entry always searches. Candidates the user never answered aren't lost by
// that — they're carried into the search's own input and re-emitted when the new
// direction still supports them (entities/companies/companySuggestions.ts), so
// the list that comes back is the same names filtered against what the user just
// said, rather than a replay of a batch they'd already walked away from.
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

  yield widgetEvent("company_checklist", {
    suggestions: r.candidates.map((c) => ({
      name: c.name,
      reasoning: c.oneLineReason,
      url: c.url,
    })),
    ...(r.provenance ? { provenance: r.provenance } : {}),
  });
  return { wrappedUp: false };
}
