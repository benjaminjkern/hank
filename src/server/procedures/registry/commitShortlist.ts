// Commit the shortlist board, then learn from where the user overruled Hank.
//
// The write itself is one transaction in entities (`commitShortlist`). What
// makes this a procedure is the second half: every row the USER moved is a
// preference signal, and the moment of commit is the last point at which it's
// still attributable. Marks are pre-selected to Hank's proposal, so a row
// carrying `proposedBy=USER` IS a disagreement by construction — the user only
// touches what they'd have had differently.
//
// The signal is relayed into the transcript as a Hank-only note and then read
// by the ordinary consolidation pass, rather than by a bespoke sub-agent. Two
// reasons: memory writes have exactly one home, and the consolidator can see
// the whole conversation around the override — the user's own words when they
// gave a reason ("I'm not interested in security"), and nothing but the move
// itself when they didn't. Both are worth remembering; only one is a quote.

import { ProposedBy, ProposedVerdict } from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session";
import { prisma } from "@/server/db/prisma";
import {
  commitShortlist,
  type CommitShortlistResult,
} from "@/server/entities/companies/commitShortlist";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";

const STANCE_WORDS: Record<ProposedVerdict, string> = {
  [ProposedVerdict.PICK]: "pick",
  [ProposedVerdict.BORDERLINE]: "borderline",
  [ProposedVerdict.PASS]: "pass",
};

type Override = { title: string; verdict: ProposedVerdict | null };

// Rows the user moved, read BEFORE the commit clears the stances.
async function loadUserOverrides(
  userId: string,
  companyId: string,
): Promise<Override[]> {
  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId,
      job: { companyId },
      proposedBy: ProposedBy.USER,
      ...onBoardWhere(),
    },
    select: { proposedVerdict: true, job: { select: { title: true } } },
  });
  return rows.map((r) => ({
    title: r.job.title,
    verdict: r.proposedVerdict,
  }));
}

function overrideNote(companyName: string, overrides: Override[]): string {
  const lines = overrides.map((o) => {
    const move = o.verdict
      ? `the user set it to ${STANCE_WORDS[o.verdict]}`
      : "the user left it undecided";
    return `- ${o.title}: ${move}`;
  });
  return [
    `The user committed the ${companyName} shortlist and overrode the proposal on ${overrides.length} role${overrides.length === 1 ? "" : "s"} — every other role was accepted as proposed:`,
    ...lines,
    "Each of these is a preference signal about what they do and don't want, whether or not they said why in the conversation.",
  ].join("\n");
}

export async function runCommitShortlist(
  args: RunContext & {
    sessionId: string;
    companyId: string;
    companyName: string;
  },
): Promise<CommitShortlistResult> {
  const overrides = await loadUserOverrides(args.userId, args.companyId);
  const result = await commitShortlist({
    userId: args.userId,
    companyId: args.companyId,
  });
  if (!result.ok) return result;

  if (overrides.length > 0) {
    // Hank-only channel: the user already knows what they clicked, and this is
    // here so the consolidation pass below has the override stated plainly
    // (its quote-grounding rule needs something in the transcript to cite).
    await appendPipelineActivity(
      args.sessionId,
      overrideNote(args.companyName, overrides),
      { runId: args.runId },
    );
    await runConsolidateSessionMemory(args);
  }
  return result;
}
