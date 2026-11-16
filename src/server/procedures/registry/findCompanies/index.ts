// Find companies worth adding to the watchlist. Assembles what the search reads
// from (profile + résumé + the whole watchlist, which is both a dedup constraint
// and signal), decides whether there's enough to search on at all, and runs the
// sub-agent.
//
// The "can we search?" check is here rather than in the caller because it's a
// judgment about whether to SPEND the call: with neither a profile nor a
// direction the sub-agent would fabricate from nothing. Both no-search outcomes
// come back as `candidates: []` with a `reason`, so the caller has one shape to
// render and never has to re-derive why.

import { recordSuggestions } from "@/server/entities/companies/companySuggestions";
import type { RunContext } from "@/server/platform/runContext";
import { procedure } from "@/server/procedures/lib/procedure";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  findCompaniesSubAgent,
  type FindCompaniesCandidate,
} from "@/server/subagents/registry/findCompanies";

import { loadFindCompaniesInput } from "./loadFindCompaniesInput";

export type FindCompaniesResult = {
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
    args: RunContext & { direction?: string; count?: number; append?: boolean },
  ): Promise<FindCompaniesResult> => {
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
  },
);
