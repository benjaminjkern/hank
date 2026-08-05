// Per-role set-asides: CLOSED ("not a fit") and DEFERRED ("could apply, just
// outranked for now"). Single-row status writes inside a walkthrough, not an
// end-of-walkthrough wrap — no focus change, no consolidate/compact, no revisit
// timer. A DEFERRED row stays reachable from the company's next-job picker until
// revived.
//
// Both go through `logJobEvent` rather than a hand-rolled update + insert: that
// seam commits the JobEvent and the status-cache flip in ONE transaction, so a
// mid-flight Stop can't strand a CLOSED status with no backing event. Neither
// dual-writes a CompanyEvent — a per-role set-aside isn't a company milestone.

import {
  type JobCloseReason,
  type JobDeferReason,
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { logJobEvent } from "./logJobEvents";

export async function closeJob(args: {
  userId: string;
  jobId: string;
  reason: JobCloseReason;
  note?: string;
}): Promise<void> {
  await logJobEvent({
    userId: args.userId,
    item: {
      jobId: args.jobId,
      type: JobEventType.CLOSED,
      notes: args.note ?? null,
      jobInteractionUpdate: {
        status: JobInteractionStatus.CLOSED,
        closeReason: args.reason,
        closeNote: args.note ?? null,
        deferReason: null,
        deferNote: null,
      },
    },
  });
}

export async function deferJob(args: {
  userId: string;
  jobId: string;
  reason: JobDeferReason;
  note?: string;
}): Promise<void> {
  await logJobEvent({
    userId: args.userId,
    item: {
      jobId: args.jobId,
      type: JobEventType.DEFERRED,
      notes: args.note ?? null,
      jobInteractionUpdate: {
        status: JobInteractionStatus.DEFERRED,
        closeReason: null,
        closeNote: null,
        deferReason: args.reason,
        deferNote: args.note ?? null,
      },
    },
  });
}

// Work a role: promote a pre-application row (NEW / SCANNED / DEFERRED) to
// SHORTLISTED so the walkthrough job arm treats it as live. The shared write
// behind two entry points — the next_job_picker "pick" branch and the
// `work_on_job` tool.
//
// APPLIED / CLOSED / interview+ rows are left alone; the job arm's defensive
// status check self-corrects those back to the company arm. Idempotent:
// re-working an already-SHORTLISTED job is a no-op-shaped write.
export async function promoteJobForWork(args: {
  userId: string;
  jobId: string;
}): Promise<void> {
  const ji = await prisma.jobInteraction.findFirst({
    where: { userId: args.userId, jobId: args.jobId },
    select: { status: true },
  });
  const promote =
    ji != null &&
    (ji.status === JobInteractionStatus.NEW ||
      ji.status === JobInteractionStatus.SCANNED ||
      ji.status === JobInteractionStatus.DEFERRED);
  if (!promote) return;
  await prisma.jobInteraction.update({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    data: {
      status: JobInteractionStatus.SHORTLISTED,
      deferReason: null,
      deferNote: null,
    },
  });
}
