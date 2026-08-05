import { widgetEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { runFindCompanies } from "@/server/procedures/registry/findCompanies";

import { loadPendingChecklist } from "./pendingWidgets";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// Find companies worth adding and put the checklist on screen. Entered by the
// `find_companies` handoff; `direction` is Hank's free-text steer (absent = work
// from the user's thesis alone).
//
// Re-entry re-SHOWS a pending checklist rather than re-running the search. The
// candidate list is an LLM call and it's already persisted in the
// widget payload, so when the user types past the checklist and comes back, the
// cheap thing is also the right thing — they see the question they still owe an
// answer to. A NEW direction always searches again: that's the user asking for
// different results, not returning to the same ones.
export async function* runDiscoveryArm(
  direction: string | undefined,
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  if (!direction) {
    const pending = await loadPendingChecklist(args.sessionId);
    if (pending) {
      yield widgetEvent("company_checklist", pending);
      return { wrappedUp: false };
    }
  }

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
  });
  return { wrappedUp: false };
}
