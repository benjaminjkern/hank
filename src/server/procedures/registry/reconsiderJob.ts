// Set a board stance on a role, reading and promoting it first when the mark
// means the user is INTERESTED in a role nobody has read — the second-look path
// behind both the panel's stance buttons and Hank's update_shortlist_proposal.
//
// Marking is not reading. A `pass` on an unread role is a rejection: it costs no
// enrich call and the row stays NEW, so it sits with the other unread ones
// instead of being promoted past them, and the commit closes it like any other
// pass. Only `pick` / `borderline` justify the read — and those DO promote out
// of NEW, because a row in the pool is what stops the next scan pass
// re-triaging (and possibly closing) a role the user just asked for. The human
// choosing it IS the judgment, so the match pass is not re-run to argue back.
//
// Decided rows — closed, delisted, applied — aren't on the board at all;
// undoing a close is a repair (update_job_interaction), not a board move.

import {
  JobEventType,
  JobInteractionStatus,
  ProposedVerdict,
} from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { logJobEvent } from "@/server/entities/jobs/logJobEvents";
import {
  setBoardStance,
  type BoardStanceMove,
} from "@/server/entities/jobs/setBoardStance";
import { isStanceable } from "@/server/entities/jobs/shortlistPool";
import {
  runEnrichJobBody,
  type EnrichJobBodyOutcome,
} from "@/server/procedures/registry/scan";

export type ReconsiderJobResult =
  | { kind: "stanced"; title: string; enriched: boolean; noBody: boolean }
  | {
      kind: "not_reconsiderable";
      title: string | null;
      status: JobInteractionStatus | null;
    };

// Interest in an unread role — the only mark worth paying a read for.
function wantsARead(verdict: ProposedVerdict | null): boolean {
  return (
    verdict === ProposedVerdict.PICK || verdict === ProposedVerdict.BORDERLINE
  );
}

export async function runReconsiderJob(
  args: RunContext & {
    jobId: string;
    // Null clears the row back to undecided.
    verdict: ProposedVerdict | null;
    reason: string | null;
    by: BoardStanceMove["by"];
  },
): Promise<ReconsiderJobResult> {
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    select: { status: true, job: { select: { title: true } } },
  });
  if (!row) return { kind: "not_reconsiderable", title: null, status: null };
  if (!isStanceable(row.status)) {
    return {
      kind: "not_reconsiderable",
      title: row.job.title,
      status: row.status,
    };
  }

  const pullingIn =
    row.status === JobInteractionStatus.NEW && wantsARead(args.verdict);
  let enrichment: EnrichJobBodyOutcome | null = null;
  if (pullingIn) {
    // Give the board and the ranker something to discuss, then promote out of
    // NEW — being in the pool is what protects the row from the next scan pass.
    enrichment = await runEnrichJobBody(args);
    await logJobEvent({
      userId: args.userId,
      item: {
        jobId: args.jobId,
        type: JobEventType.SCANNED,
        notes: "Read early for the shortlist board.",
        jobInteractionUpdate: { status: JobInteractionStatus.SCANNED },
      },
    });
  }

  const stance = await setBoardStance({
    userId: args.userId,
    jobId: args.jobId,
    ...(args.by === "agent"
      ? ({ by: "agent", verdict: args.verdict, reason: args.reason } as const)
      : ({ by: "user", verdict: args.verdict } as const)),
    // A role just pulled in wasn't on the board a moment ago, so there's no
    // "where it was" to hold it in — landing in the chosen group IS the
    // feedback for the click. Every other mark leaves placement alone.
    ...(pullingIn ? { place: true } : {}),
  });
  if (!stance.ok) {
    return {
      kind: "not_reconsiderable",
      title: row.job.title,
      status: stance.status,
    };
  }
  return {
    kind: "stanced",
    title: stance.title,
    enriched: enrichment === "enriched",
    noBody: enrichment === "no_body",
  };
}
