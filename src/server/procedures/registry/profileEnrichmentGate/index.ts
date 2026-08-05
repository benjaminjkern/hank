// "Is the profile enriched enough to start matching jobs?" — the one place that
// question is answered.
//
// Three steps, and both callers (runWhatsNext's rung 0 and runCommitProfile's
// pass gate) need all three, which is why they live here rather than being
// spelled twice:
//   1. the deterministic length pre-gate, applied to the slots the loader just
//      read — an obviously-full profile never reaches the LLM;
//   2. the profileEnrichmentCheck sub-agent on everything else;
//   3. the conservative default when that call FAILS. A failed verdict routes the
//      user into profile enrichment rather than into a walkthrough with a hollow
//      thesis: one more profile question is cheap, bad downstream output isn't.
//      The enrich agent can elicit even without a specific `missing` list.

import type { RunContext } from "@/server/agent/contracts";
import { isProfileEnrichedByLength } from "@/server/entities/profile/profileInventory";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  profileEnrichmentCheckSubAgent,
  type ProfileEnrichmentVerdict,
} from "@/server/subagents/registry/profileEnrichmentCheck";

import { loadProfileEnrichmentCheckInput } from "./loadProfileEnrichmentCheckInput";

export async function runProfileEnrichmentGate(
  ctx: RunContext,
): Promise<ProfileEnrichmentVerdict> {
  // One read serves both steps: the length pre-gate is a rule over the same
  // slots the sub-agent would be handed, so an obviously-full profile costs a
  // memory read and no LLM call.
  const input = await loadProfileEnrichmentCheckInput(ctx.userId);
  if (isProfileEnrichedByLength(input.inventory)) return { enriched: true };

  const result = await runSubAgent(profileEnrichmentCheckSubAgent, input, ctx);
  if (!result.ok) return { enriched: false, missing: [], suggestedProbes: [] };
  return result.output;
}
