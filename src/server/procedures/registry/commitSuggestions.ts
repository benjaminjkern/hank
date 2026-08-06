// The company_checklist came back: record every verdict, add what was kept, and
// learn from what wasn't.
//
// Adding is the obvious half and it already had a home (`runChecklistAdd`).
// What makes this a procedure is the other half: the search proposes, the user
// prunes, and until now the pruning was thrown away — the declined names never
// reached the DB, so the same company could be proposed again next run, and the
// reason it was wrong reached nothing at all.
//
// A decline is the ONLY channel the user has for telling the search it was
// wrong, so it's treated the way the shortlist board treats an override: recorded
// against the row, relayed into the transcript, and consolidated into memory by
// the ordinary pass — which can see the conversation around it and knows the
// difference between a stated reason and a silent one.
//
// What lands in memory is the PATTERN, not the roster. "Turned down three
// companies over ~5000 people" is a thesis refinement worth keeping; "declined
// Databricks" is already a row in CompanySuggestion and belongs nowhere else.

import { CompanySuggestionVerdict } from "@/generated/prisma/client";
import { appendPipelineActivity } from "@/server/agent/session/appendMessages";
import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { narrateStatus } from "@/server/agent/session";
import { SUGGESTION_DECLINE_LABELS } from "@/server/entities/companies/companySuggestionInputs";
import { settleSuggestions } from "@/server/entities/companies/companySuggestions";
import { runChecklistAdd } from "@/server/procedures/registry/enrichCompanies/runChecklistAdd";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";
import type { DeclinedCompany, PickedCompany } from "@/server/widgets/parse";

type CommitSuggestionsArgs = RunContext & {
  sessionId: string;
  picked: PickedCompany[];
  declined: DeclinedCompany[];
};

function declineNote(
  picked: PickedCompany[],
  declined: DeclinedCompany[],
): string {
  const lines = declined.map((d) => {
    const label = d.reason ? SUGGESTION_DECLINE_LABELS[d.reason] : null;
    const why = [label, d.note?.trim()].filter(Boolean).join(" — ");
    return `- ${d.name}${why ? `: ${why}` : " (no reason given)"}`;
  });
  const kept = picked.length
    ? `kept ${picked.length} (${picked.map((p) => p.name).join(", ")})`
    : "kept none of them";
  return [
    `The user went through the companies you suggested and turned down ${declined.length} of them — ${kept}:`,
    ...lines,
    "",
    "What they rejected says something about the shape they're actually after. A reason given once is a preference; the same reason across several is the thesis narrowing. A bare decline is still signal about that company's shape — but they didn't say why, so don't decide why for them.",
  ].join("\n");
}

export async function* runCommitSuggestions(
  args: CommitSuggestionsArgs,
): AsyncGenerator<TurnEvent> {
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
        ...(d.reason ? { declineReason: d.reason } : {}),
        ...(d.note ? { declineNote: d.note } : {}),
      })),
    ],
  });

  if (picked.length > 0) {
    yield* runChecklistAdd(picked, args);
  } else {
    yield* narrateStatus(
      args.sessionId,
      "No worries — nothing added. Tell me what else you're after whenever you like.",
      args.runId,
    );
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
      declineNote(picked, declined),
      { runId: args.runId },
    );
    await runConsolidateSessionMemory(args);
  }
}
