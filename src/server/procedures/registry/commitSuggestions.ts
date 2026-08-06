// The company_checklist came back: record every verdict, add what was kept, and
// learn from what wasn't.
//
// Adding is the obvious half and it already had a home (`runChecklistAdd`).
// What makes this a procedure is the other half: the search proposes, the user
// prunes, and the pruning is signal — the declined names are what stop the same
// company coming back next run.
//
// A decline is a BIT: this name, wrong. The reason lives in the conversation
// around it, where one sentence covers the whole batch, so the relay below puts
// the declines in the transcript and lets the ordinary consolidation pass read
// them together with whatever the user actually said. What lands in memory is
// the PATTERN, not the roster — "turned down three companies over ~5000 people"
// is a thesis refinement worth keeping; "declined Databricks" is already a row
// in CompanySuggestion and belongs nowhere else.

import { CompanySuggestionVerdict } from "@/generated/prisma/client";
import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session/appendMessages";
import { settleSuggestions } from "@/server/entities/companies/companySuggestions";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";
import {
  promptAddMoreCompanies,
  runChecklistAdd,
  type ChecklistAddResult,
} from "@/server/procedures/registry/enrichCompanies";
import type { DeclinedCompany, PickedCompany } from "@/server/widgets/parse";

type CommitSuggestionsArgs = RunContext & {
  sessionId: string;
  picked: PickedCompany[];
  declined: DeclinedCompany[];
};

function renderDeclineRelay(
  picked: PickedCompany[],
  declined: DeclinedCompany[],
): string {
  const kept = picked.length
    ? `kept ${picked.length} (${picked.map((p) => p.name).join(", ")})`
    : "kept none of them";
  return [
    `The user went through the companies you suggested and turned down ${declined.length} of them — ${kept}:`,
    ...declined.map((d) => `- ${d.name}`),
    "",
    "They unchecked these without being asked why, so whatever reason exists is in what they've SAID, not here. If they told you what was off about the batch, that's the signal — one stated preference generalizes further than the list of names does. If they said nothing, treat it as mild negative signal on the shape of these companies and don't decide a motive for them.",
  ].join("\n");
}

// Returns nothing: this ends on a question the user owes an answer to either
// way — the add-more prompt, or the disambiguation picker it defers to — so the
// caller has no branch left to take.
export async function* runCommitSuggestions(
  args: CommitSuggestionsArgs,
): AsyncGenerator<TurnEvent, void> {
  const { picked, declined } = args;

  // Verdicts first, so they're on file even if the enrich below fails or the
  // user hits Stop partway through it.
  await settleSuggestions({
    userId: args.userId,
    runId: args.runId,
    sessionId: args.sessionId,
    decisions: [
      ...picked.map((p) => ({
        name: p.name,
        verdict: CompanySuggestionVerdict.ADDED,
      })),
      ...declined.map((d) => ({
        name: d.name,
        verdict: CompanySuggestionVerdict.DECLINED,
      })),
    ],
  });

  // The skip-all case narrates nothing: the add-more prompt below already opens
  // with "Nothing added this round", so a line saying it too just repeats.
  let added: ChecklistAddResult = { awaitingDisambiguation: false, added: [] };
  if (picked.length > 0) {
    added = yield* runChecklistAdd(picked, args);
  }

  // Only a decline is worth a consolidation pass. Keeping everything the search
  // proposed says nothing new — the accepted companies are on the watchlist,
  // which the next search already reads.
  if (declined.length > 0) {
    // Hank-only channel: the user knows what they unchecked, and this is here so
    // the consolidation pass below has the declines stated plainly (its
    // quote-grounding rule needs something in the transcript to cite).
    await appendPipelineActivity(
      args.sessionId,
      renderDeclineRelay(picked, declined),
      {
        runId: args.runId,
      },
    );
    await runConsolidateSessionMemory(args);
  }

  // Ask the local question rather than leaving the user on a batch of ✓ lines —
  // unless a disambiguation picker is already waiting on them.
  if (!added.awaitingDisambiguation) {
    yield* promptAddMoreCompanies(added.added, args);
  }
}
