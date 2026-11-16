// Find companies worth adding to the watchlist and put them on the discovery
// panel. Entered by `find_companies` — Hank's tool; `direction` is his free-text
// steer (absent = work from the user's thesis alone).
//
// Re-entry always searches. Candidates the user never marked aren't lost by
// that — they're carried into the search's own input and re-emitted when the new
// direction still supports them (entities/companies/companySuggestions.ts), so
// the list that comes back is the same names filtered against what the user just
// said rather than a replay of a batch they'd walked away from.
//
// The "can we search?" check is a judgment about whether to SPEND the call: with
// neither a profile nor a direction the sub-agent would fabricate from nothing.

import { sayUiEvents } from "@/server/contracts";
import type { StepArgs, StepOutcome } from "@/server/contracts";
import { recordSuggestions } from "@/server/entities/companies/companySuggestions";
import type { RunContext } from "@/server/platform/runContext";
import { procedure } from "@/server/procedures/lib/procedure";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  findCompaniesSubAgent,
  type FindCompaniesCandidate,
} from "@/server/subagents/registry/findCompanies";
import { buildDiscoveryEvents } from "@/server/views/showEvents";
import { formatFocusRefToken } from "@/shared/focusRefToken";

import { loadFindCompaniesInput } from "./loadFindCompaniesInput";

type SearchResult = {
  candidates: FindCompaniesCandidate[];
  // One user-facing line on how the batch was found — rendered above the
  // checklist so a bad run is diagnosable rather than a black box.
  provenance?: string;
  // Why the list is empty, so the caller can phrase the two cases differently:
  // "no_basis" / "failed" = we couldn't search; "none_found" = we did and the
  // watchlist already covers the ground.
  reason?: "no_basis" | "failed" | "none_found";
};

// Enough of a thesis, or an explicit steer, to search on. Below both thresholds
// the sub-agent has nothing to work from.
const MIN_PROFILE_CHARS = 20;
const MIN_DIRECTION_CHARS = 3;

export const runFindCompanies = procedure(
  "find_companies",
  async (
    input: StepArgs & { direction?: string; append?: boolean },
  ): Promise<StepOutcome> => {
    const r = await searchCompanies(input);
    const { say } = input;

    // Both empty cases have to speak for themselves — a handoff already ended
    // Hank's turn, so there's no reply coming after this.
    if (r.reason === "no_basis" || r.reason === "failed") {
      await say({
        type: "text",
        text: "I couldn't put a search together just now. What kind of companies are you looking for — sector, stage, the shape of the role?",
      });
      return {};
    }
    if (r.reason === "none_found") {
      await say({
        type: "text",
        text: "I looked, but nothing new came up beyond what's already on your list. Want me to try a different angle — a different sector or stage, or casting wider?",
      });
      return {};
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
    await say({
      type: "text",
      text: `${opener}Put ${count} on ${chip} — they're all set to add, so uncheck any you don't want and send. Tell me what's off about them and I'll look again instead.`,
    });
    await sayUiEvents(say, (await buildDiscoveryEvents(input.userId)).events);
    return {};
  },
);

// Assemble what the search reads from (profile + résumé + the whole watchlist,
// which is both a dedup constraint and signal), decide whether there's enough to
// search on, and run the sub-agent. Both no-search outcomes come back as
// `candidates: []` with a `reason`, so the caller has one shape to render.
async function searchCompanies(
  args: RunContext & { direction?: string; count?: number; append?: boolean },
): Promise<SearchResult> {
  const input = await loadFindCompaniesInput({
    userId: args.userId,
    direction: args.direction,
    count: args.count,
  });

  const canSearch =
    (input.profile ?? "").trim().length >= MIN_PROFILE_CHARS ||
    (input.direction ?? "").trim().length >= MIN_DIRECTION_CHARS;
  if (!canSearch) return { candidates: [], reason: "no_basis" };

  const r = await runSubAgent(findCompaniesSubAgent, input, args);
  if (!r.ok) return { candidates: [], reason: "failed" };
  if (r.output.candidates.length === 0) {
    return { candidates: [], reason: "none_found" };
  }

  // Record the batch as PROPOSED (no verdict yet). Written here rather than at
  // submit so a batch the user types past is still on file — and so the decline
  // that follows has a row to land on.
  await recordSuggestions({
    userId: args.userId,
    runId: args.runId,
    sessionId: args.sessionId,
    append: args.append,
    suggestions: r.output.candidates.map((c) => ({
      name: c.name,
      reason: c.oneLineReason,
      summary: c.summary,
      url: c.url,
    })),
  });
  return {
    candidates: r.output.candidates,
    ...(r.output.provenance ? { provenance: r.output.provenance } : {}),
  };
}
