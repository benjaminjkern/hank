// Mark an application submitted, then learn from where the user rewrote Hank.
//
// The status write itself is one transaction in entities (`markJobApplied`).
// What makes this a procedure is the second half: submit is the last moment at
// which "Hank wrote X, the user sent Y" is still attributable, and that gap is
// the most direct preference signal in the product — voice, the claims they
// won't make, the angles they cut. Hank's draft IS the starting text, so any
// divergence is an override by construction; nothing has to be flagged.
//
// The signal is relayed into the transcript as a Hank-only note and then read by
// the ordinary consolidation pass rather than a bespoke sub-agent, for the same
// two reasons the shortlist commit does it that way: memory writes have exactly
// one home, and the consolidator can see the conversation around the change —
// the user's own words when they said why, and only the edit itself when they
// didn't.
//
// Submit does NOT close the page. An application stays editable because its text
// is reusable elsewhere; what stops is the relay (an APPLIED row's edits are
// housekeeping, not something to reconsider) — see `listUnrelayedApplicationEdits`.

import type { RunContext } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session";
import { prisma } from "@/server/db/prisma";
import {
  applicationEditsFor,
  proposedDraftsPatch,
  type ApplicationEdit,
} from "@/server/entities/jobs/applicationDrafts";
import {
  markJobApplied,
  type MarkJobAppliedResult,
} from "@/server/entities/jobs/markJobApplied";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";
import { renderWordDiff } from "@/utils/diff";

function overrideNote(
  jobTitle: string,
  companyName: string,
  edits: ApplicationEdit[],
): string {
  const lines = edits.map((e) => {
    const verb =
      e.change === "wrote"
        ? "wrote this themselves rather than take a draft"
        : e.change === "cleared"
          ? "deleted the draft entirely"
          : "rewrote your draft";
    return `- ${e.label} — ${verb}:\n    ${renderWordDiff(e.diff)}`;
  });
  return [
    `The user submitted their ${companyName} application for ${jobTitle}. Before sending it they changed ${edits.length === 1 ? "one thing" : `${edits.length} things`} you had written — everything else went out as drafted:`,
    ...lines,
    "",
    "[-cut-] and {+added+} mark what moved. What they changed says something about how they want to come across and what they will and won't claim, whether or not they explained it in the conversation.",
  ].join("\n");
}

export async function runCommitApplication(
  args: RunContext & { sessionId: string; jobId: string },
): Promise<MarkJobAppliedResult> {
  // Read the divergences BEFORE the baseline is re-stamped below.
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    select: {
      coverLetter: true,
      coverLetterReuse: true,
      shortAnswers: true,
      shortAnswersReuse: true,
      proposedDrafts: true,
      job: {
        select: {
          title: true,
          companyName: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  const edits = row ? applicationEditsFor(row) : [];

  const result = await markJobApplied({
    userId: args.userId,
    jobId: args.jobId,
  });

  if (edits.length > 0 && row) {
    // Settle the baseline first: submitting is the last time these count as
    // changes, and leaving them diverged would re-relay the whole set on the
    // user's next message.
    await prisma.jobInteraction.update({
      where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
      data: { proposedDrafts: proposedDraftsPatch(row) },
      select: { id: true },
    });
    // Hank-only channel: the user already knows what they typed, and this is
    // here so the consolidation pass below has the change stated plainly (its
    // quote-grounding rule needs something in the transcript to cite).
    await appendPipelineActivity(
      args.sessionId,
      overrideNote(
        row.job.title,
        row.job.company?.name ?? row.job.companyName ?? "the company",
        edits,
      ),
      { runId: args.runId },
    );
    await runConsolidateSessionMemory(args);
  }

  return result;
}
