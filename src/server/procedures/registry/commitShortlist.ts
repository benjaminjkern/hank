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

import { JobEventType, ProposedVerdict } from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { appendPipelineActivity } from "@/server/agent/session";
import { prisma } from "@/server/db/prisma";
import {
  commitShortlist,
  type CommitShortlistResult,
} from "@/server/entities/companies/commitShortlist";
import { roundStartedAt } from "@/server/entities/jobs/boardStance";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";
import { runConsolidateSessionMemory } from "@/server/procedures/registry/consolidateSessionMemory";

const STANCE_WORDS: Record<ProposedVerdict, string> = {
  [ProposedVerdict.PICK]: "pick",
  [ProposedVerdict.BORDERLINE]: "borderline",
  [ProposedVerdict.PASS]: "pass",
};

type Override = {
  title: string;
  // What the user set it to. Null = they cleared it back to undecided.
  verdict: ProposedVerdict | null;
  // What Hank had proposed, so the note says what was overruled rather than
  // just where the row ended up.
  agentVerdict: ProposedVerdict | null;
  agentReason: string | null;
};

// Rows the user moved, read BEFORE the commit clears the stances.
async function loadUserOverrides(
  userId: string,
  companyId: string,
): Promise<Override[]> {
  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId,
      job: { companyId },
      userVerdict: { not: null },
      ...onBoardWhere(),
    },
    select: {
      agentVerdict: true,
      agentReason: true,
      userVerdict: true,
      job: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    title: r.job.title,
    verdict: r.userVerdict,
    agentVerdict: r.agentVerdict,
    agentReason: r.agentReason,
  }));
}

function overrideNote(companyName: string, overrides: Override[]): string {
  const lines = overrides.map((o) => {
    const to = o.verdict
      ? `the user set it to ${STANCE_WORDS[o.verdict]}`
      : "the user left it undecided";
    const from = o.agentVerdict
      ? `, over your ${STANCE_WORDS[o.agentVerdict]}${o.agentReason ? ` ("${o.agentReason}")` : ""}`
      : "";
    return `- ${o.title}: ${to}${from}`;
  });
  return [
    `The user committed the ${companyName} shortlist and overrode the proposal on ${overrides.length} role${overrides.length === 1 ? "" : "s"} — every other role was accepted as proposed:`,
    ...lines,
    "Each of these is a preference signal about what they do and don't want, whether or not they said why in the conversation. What they overruled you ON is the part worth learning from.",
  ].join("\n");
}

// Roles this round's automatic filtering closed and the user pulled back. The
// close REASON is the thing being overruled, so a repeat ("three location
// mismatches revived in one round") says the filter is miscalibrated — which is
// worth more than any single role.
async function loadRevivals(
  userId: string,
  companyId: string,
  since: Date | null,
): Promise<string[]> {
  if (!since) return [];
  const events = await prisma.jobEvent.findMany({
    where: {
      type: JobEventType.REVIVED,
      occurredAt: { gte: since },
      jobInteraction: { userId, job: { companyId } },
    },
    select: {
      notes: true,
      jobInteraction: { select: { job: { select: { title: true } } } },
    },
  });
  return events.map(
    (e) => `- ${e.jobInteraction.job.title}: ${e.notes ?? "revived"}`,
  );
}

export async function runCommitShortlist(
  args: RunContext & {
    sessionId: string;
    companyId: string;
    companyName: string;
  },
): Promise<CommitShortlistResult> {
  // Both reads happen BEFORE the commit clears the stances and re-anchors the
  // round; afterwards neither is recoverable.
  const [overrides, revivals] = await Promise.all([
    loadUserOverrides(args.userId, args.companyId),
    roundStartedAt(args.userId, args.companyId).then((since) =>
      loadRevivals(args.userId, args.companyId, since),
    ),
  ]);
  const result = await commitShortlist({
    userId: args.userId,
    companyId: args.companyId,
  });
  if (!result.ok) return result;

  if (overrides.length > 0 || revivals.length > 0) {
    // Hank-only channel: the user already knows what they clicked, and this is
    // here so the consolidation pass below has the corrections stated plainly
    // (its quote-grounding rule needs something in the transcript to cite).
    await appendPipelineActivity(
      args.sessionId,
      [
        overrides.length > 0 ? overrideNote(args.companyName, overrides) : null,
        revivals.length > 0
          ? [
              `The user also pulled ${revivals.length} role${revivals.length === 1 ? "" : "s"} back that the automatic filtering had closed at ${args.companyName}:`,
              ...revivals,
              "A close REASON showing up repeatedly here is the filter being miscalibrated, which is worth more than any one role.",
            ].join("\n")
          : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
      { runId: args.runId },
    );
    await runConsolidateSessionMemory(args);
  }
  return result;
}
