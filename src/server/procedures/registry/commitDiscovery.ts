// Make the discovery list's marks real: add what's marked ADD, record what's
// marked PASS, and learn from the passes.
//
// The board's analogue, down to the shape — the user negotiates on a panel, and
// ONE agent call settles the whole surface. Unmarked rows are untouched on
// purpose: they stay on the table and ride into the next search, so committing
// is never "answer everything or lose it".
//
// A pass is a BIT: this name, wrong. The reason lives in the conversation
// around it, where one sentence covers the batch, so the relay below puts the
// passes in the transcript and lets the ordinary consolidation pass read them
// together with whatever the user actually said. What lands in memory is the
// PATTERN, not the roster.

import { CompanySuggestionVerdict } from "@/generated/prisma/client";
import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session/appendMessages";
import {
  listMarkedSuggestions,
  settleMarkedSuggestions,
  type MarkedSuggestion,
} from "@/server/entities/companies/suggestionMark";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";
import {
  promptAddMoreCompanies,
  runChecklistAdd,
} from "@/server/procedures/registry/enrichCompanies";

export type CommitDiscoveryResult = {
  // Nothing was marked — the caller turns this into a "mark some first" nudge
  // rather than a silent no-op.
  empty: boolean;
  added: string[];
  passed: string[];
};

function renderPassRelay(passed: MarkedSuggestion[], added: string[]): string {
  const kept = added.length
    ? `added ${added.length} (${added.join(", ")})`
    : "added none of them";
  return [
    `The user went through the companies you found and passed on ${passed.length} of them — ${kept}:`,
    ...passed.map((p) => `- ${p.name}`),
    "",
    "They passed without being asked why, so whatever reason exists is in what they've SAID, not here. If they told you what was off about the batch, that's the signal — one stated preference generalizes further than the list of names does. If they said nothing, treat it as mild negative signal on the shape of these companies and don't decide a motive for them.",
  ].join("\n");
}

export async function* runCommitDiscovery(
  args: RunContext & { sessionId: string },
): AsyncGenerator<TurnEvent, CommitDiscoveryResult> {
  const marked = await listMarkedSuggestions(args.userId);
  if (marked.length === 0) {
    return { empty: true, added: [], passed: [] };
  }

  const toAdd = marked.filter((m) => m.mark === "ADD");
  const toPass = marked.filter((m) => m.mark === "PASS");

  // Verdicts first, so they're on file even if the enrich below fails or the
  // user hits Stop partway through it.
  await settleMarkedSuggestions({
    userId: args.userId,
    decided: [
      ...toAdd.map((m) => ({
        id: m.id,
        verdict: CompanySuggestionVerdict.ADDED,
      })),
      ...toPass.map((m) => ({
        id: m.id,
        verdict: CompanySuggestionVerdict.DECLINED,
      })),
    ],
  });

  let added: string[] = [];
  if (toAdd.length > 0) {
    // Each pick carries the search's own case for it (→ hunter extraContext)
    // and any captured board URL (→ hunter candidateUrl), not just the bare
    // name — that's what stops a name collision resolving to the wrong company.
    const result = yield* runChecklistAdd(
      toAdd.map((m) => ({
        name: m.name,
        context: m.reason,
        ...(m.url ? { url: m.url } : {}),
      })),
      args,
    );
    added = result.added;
    // A disambiguation picker is a genuine wait-for-user question — stop rather
    // than stacking the add-more card under an unanswered one.
    if (result.awaitingDisambiguation) {
      return { empty: false, added, passed: toPass.map((p) => p.name) };
    }
  }

  // Only a pass is worth a consolidation pass. Keeping what the search proposed
  // says nothing new — the added companies are on the watchlist, which the next
  // search already reads.
  if (toPass.length > 0) {
    // Hank-only channel: the user knows what they passed on, and this is here so
    // the consolidation pass below has the passes stated plainly.
    await appendPipelineActivity(
      args.sessionId,
      renderPassRelay(toPass, added),
      { runId: args.runId },
    );
    await runConsolidateSessionMemory(args);
  }

  yield* promptAddMoreCompanies(added, toPass.length, args);
  return { empty: false, added, passed: toPass.map((p) => p.name) };
}
