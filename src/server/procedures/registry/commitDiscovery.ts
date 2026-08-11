// Make the discovery list real: add every company still checked, record the
// unchecked ones so the search stops proposing them.
//
// The board's analogue, down to the shape — the user negotiates on a panel, and
// ONE agent call settles the whole surface. It settles the BATCH, not "the
// marked rows": every candidate arrives checked, so there is no third state to
// leave behind and nothing on screen survives the commit.
//
// It reads the same view the panel drew, which is what guarantees the commit
// acts on exactly what the user was looking at rather than on a pool query that
// could have drifted.
//
// A pass is a BIT: this name, wrong. The reason lives in the conversation around
// it, where one sentence covers the batch, so the relay below puts the passes in
// the transcript and lets the ordinary consolidation pass read them together
// with whatever the user actually said. What lands in memory is the PATTERN, not
// the roster.

import { CompanySuggestionVerdict } from "@/generated/prisma/client";
import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session/appendMessages";
import { settleSuggestionBatch } from "@/server/entities/companies/suggestionMark";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";
import {
  promptAddMoreCompanies,
  runChecklistAdd,
} from "@/server/procedures/registry/enrichCompanies";
import { loadDiscoveryList } from "@/server/views/discoveryList";

export type CommitDiscoveryResult = {
  // The list was already empty — the caller turns this into a "there's nothing
  // on screen" nudge rather than a silent no-op.
  empty: boolean;
  added: string[];
  passed: string[];
};

function renderPassRelay(passed: string[], added: string[]): string {
  const kept = added.length
    ? `added ${added.length} (${added.join(", ")})`
    : "added none of them";
  return [
    `The user went through the companies you found and unchecked ${passed.length} of them — ${kept}:`,
    ...passed.map((name) => `- ${name}`),
    "",
    "They unchecked these without being asked why, so whatever reason exists is in what they've SAID, not here. If they told you what was off about the batch, that's the signal — one stated preference generalizes further than the list of names does. If they said nothing, treat it as mild negative signal on the shape of these companies and don't decide a motive for them.",
  ].join("\n");
}

export async function* runCommitDiscovery(
  args: RunContext & { sessionId: string },
): AsyncGenerator<TurnEvent, CommitDiscoveryResult> {
  const { rows } = await loadDiscoveryList(args.userId);
  if (rows.length === 0) {
    return { empty: true, added: [], passed: [] };
  }

  const toAdd = rows.filter((r) => r.checked);
  const toPass = rows.filter((r) => !r.checked);

  // Verdicts first, so they're on file even if the enrich below fails or the
  // user hits Stop partway through it.
  await settleSuggestionBatch({
    userId: args.userId,
    decided: [
      ...toAdd.map((r) => ({
        id: r.id,
        verdict: CompanySuggestionVerdict.ADDED,
      })),
      ...toPass.map((r) => ({
        id: r.id,
        verdict: CompanySuggestionVerdict.DECLINED,
      })),
    ],
  });

  const passedNames = toPass.map((r) => r.name);
  let added: string[] = [];
  if (toAdd.length > 0) {
    // Each pick carries the search's own case for it (→ hunter extraContext)
    // and any captured board URL (→ hunter candidateUrl), not just the bare
    // name — that's what stops a name collision resolving to the wrong company.
    const result = yield* runChecklistAdd(
      toAdd.map((r) => ({
        name: r.name,
        context: r.reason,
        ...(r.url ? { url: r.url } : {}),
      })),
      args,
    );
    added = result.added;
    // A disambiguation picker is a genuine wait-for-user question — stop rather
    // than stacking the add-more card under an unanswered one.
    if (result.awaitingDisambiguation) {
      return { empty: false, added, passed: passedNames };
    }
  }

  // Only a pass is worth a consolidation pass. Keeping what the search proposed
  // says nothing new — the added companies are on the watchlist, which the next
  // search already reads.
  if (toPass.length > 0) {
    // Hank-only channel: the user knows what they unchecked, and this is here so
    // the consolidation pass below has the passes stated plainly.
    await appendPipelineActivity(
      args.sessionId,
      renderPassRelay(passedNames, added),
      { runId: args.runId },
    );
    await runConsolidateSessionMemory(args);
  }

  yield* promptAddMoreCompanies(added, toPass.length, args);
  return { empty: false, added, passed: passedNames };
}
