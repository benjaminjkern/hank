// Put roles the automatic filtering closed back in the running.
//
// The pre-scan closes from titles alone, so most of what it filters was never
// body-read. Reviving therefore returns a row to NEW rather than SCANNED and
// costs no LLM call; a role that HAD been read before being closed goes back to
// SCANNED.
//
// It logs a REVIVED event on purpose. This is not a bookkeeping repair — the
// user overruling a filter is a thing that happened, and it's the strongest
// correction the board can carry: the commit-time memory pass reads these back
// to notice that a close REASON is miscalibrated ("three location-mismatch
// closes revived in one round").
//
// Called from ONE place — `settleRelayedBoardEdits`, when a mark that wants the
// role back is relayed. Marking is a proposal; this is the structural change
// that proposal earns once Hank has seen it.

import {
  JobCloseReason,
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { humanJobCloseReason } from "./humanJobReasonLabels";
import { logJobEvents } from "./logJobEvents";

export async function reviveFilteredJobs(args: {
  userId: string;
  jobIds: string[];
}): Promise<{ revivedJobIds: string[] }> {
  if (args.jobIds.length === 0) return { revivedJobIds: [] };

  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId: args.userId,
      jobId: { in: args.jobIds },
      status: JobInteractionStatus.CLOSED,
    },
    select: { jobId: true, closeReason: true, matchBucket: true },
  });
  if (rows.length === 0) return { revivedJobIds: [] };

  await logJobEvents({
    userId: args.userId,
    items: rows.map((row) => ({
      jobId: row.jobId,
      type: JobEventType.REVIVED,
      // The close reason is the thing being overruled, so it goes in the note —
      // that's what makes the pattern readable later without asking the user why.
      notes: `User overruled an automatic close (${
        row.closeReason
          ? humanJobCloseReason(row.closeReason as JobCloseReason)
          : "no reason recorded"
      }).`,
      jobInteractionUpdate: {
        // matchBucket is only ever written by the scan pass, so it's the one
        // honest signal for "was this body ever read" — a pre-scan close has none.
        status: row.matchBucket
          ? JobInteractionStatus.SCANNED
          : JobInteractionStatus.NEW,
        closeReason: null,
        closeNote: null,
      },
    })),
  });
  return { revivedJobIds: rows.map((r) => r.jobId) };
}
