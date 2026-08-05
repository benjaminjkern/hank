// Bulk "close these roles, each with its own reason and note" — the write behind
// a scan pass that disqualifies a batch of jobs at once (pre-scan's metadata
// bucketing).
//
// Goes through `logJobEvents` rather than hand-rolling the event + status pair:
// that seam commits the JobEvent and the status-cache flip together, which is
// the point (a mid-flight Stop between them would strand a CLOSED status with no
// backing event). It is also why this takes the WHOLE set in one call rather
// than one call per reason bucket — the seam's cost is a constant number of
// statements, so splitting the set only multiplies transactions.
//
// `jobInteractionUpdate` is passed explicitly rather than "auto": auto derives
// status from EVENT_TO_STATUS (CLOSED → CLOSED, correct) but only stamps a
// closeReason for WITHDRAWN, and the whole point here is recording WHY.
//
// No CompanyEvent fan-out: CLOSED is deliberately absent from
// DUAL_WRITE_COMPANY_EVENT because batch closes collapse to ONE summary
// CompanyEvent at their seam. The caller writes that summary (a JOBS_CLOSED
// row per reason bucket); this function must not also emit one per job.

import {
  type JobCloseReason,
  EventSource,
  JobInteractionStatus,
  JobEventType,
} from "@/generated/prisma/client";

import { logJobEvents } from "./logJobEvents";

export async function closeJobs(args: {
  userId: string;
  // A reason AND a note per job: the reason is what the dashboard and
  // `whats_next` query against, while the note is the sentence the user reads
  // next to that specific role. A pass closing eight roles as NOT_A_MATCH still
  // owes each of them its own "why".
  jobs: Array<{
    id: string;
    closeReason: JobCloseReason;
    closeNote: string;
    closeSummaryLabel?: string | null;
  }>;
  source?: EventSource;
}): Promise<void> {
  if (args.jobs.length === 0) return;

  await logJobEvents({
    userId: args.userId,
    items: args.jobs.map((job) => ({
      jobId: job.id,
      type: JobEventType.CLOSED,
      notes: job.closeNote,
      source: args.source ?? EventSource.CHAT_EXTRACTED,
      jobInteractionUpdate: {
        status: JobInteractionStatus.CLOSED,
        closeReason: job.closeReason,
        closeNote: job.closeNote,
        closeSummaryLabel: job.closeSummaryLabel ?? null,
      },
    })),
  });
}
