// Put a role the automatic filtering closed back in the running.
//
// The pre-scan closes from titles alone, so most of what it filters was never
// body-read. Reviving therefore returns the row to NEW rather than SCANNED and
// costs no LLM call — it lands in the board's "not read yet" group, and marking
// it pick/borderline from there is what pays for the read (runReconsiderJob).
// A role that HAD been read before being closed goes back to SCANNED.
//
// It logs a REVIVED event on purpose. This is not a bookkeeping repair — the
// user overruling a filter is a thing that happened, and it's the strongest
// correction the board can carry: the commit-time memory pass reads these back
// to notice that a close REASON is miscalibrated ("three location-mismatch
// closes revived in one round").

import {
  JobCloseReason,
  JobEventType,
  JobInteractionStatus,
  ProposedVerdict,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { humanJobCloseReason } from "./humanJobReasonLabels";
import { logJobEvent } from "./logJobEvents";

export type ReviveFilteredJobResult =
  | { ok: true; title: string; status: JobInteractionStatus }
  | { ok: false; code: "NOT_FOUND" | "NOT_CLOSED"; title: string | null };

export async function reviveFilteredJob(args: {
  userId: string;
  jobId: string;
}): Promise<ReviveFilteredJobResult> {
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    select: {
      status: true,
      closeReason: true,
      closeNote: true,
      matchBucket: true,
      job: { select: { title: true } },
    },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", title: null };
  if (row.status !== JobInteractionStatus.CLOSED) {
    return { ok: false, code: "NOT_CLOSED", title: row.job.title };
  }

  // matchBucket is only ever written by the scan pass, so it's the one honest
  // signal for "was this body ever read" — a pre-scan close has none.
  const status = row.matchBucket
    ? JobInteractionStatus.SCANNED
    : JobInteractionStatus.NEW;

  // The close reason is the thing being overruled, so it goes in the note —
  // that's what makes the pattern readable later without asking the user why.
  const overruled = row.closeReason
    ? humanJobCloseReason(row.closeReason as JobCloseReason)
    : "no reason recorded";

  await logJobEvent({
    userId: args.userId,
    item: {
      jobId: args.jobId,
      type: JobEventType.REVIVED,
      notes: `User overruled an automatic close (${overruled}).`,
      jobInteractionUpdate: {
        status,
        closeReason: null,
        closeNote: null,
        // Back in the running, still DRAWN in the discard pile it came from.
        // Un-closing changes the row's status, which would otherwise re-tier it
        // instantly and make it jump out from under the user mid-review; the
        // stance that follows is pending like any other user mark, and the
        // relay settles placement on their next message.
        placementVerdict: ProposedVerdict.PASS,
      },
    },
  });
  return { ok: true, title: row.job.title, status };
}
