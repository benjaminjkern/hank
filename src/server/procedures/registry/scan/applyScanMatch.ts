// Persist the scan step's per-job verdict onto the JobInteraction.
//
// Two paths, both following the clear-on-transition rule: the match path stamps
// the bucket/score/reason and clears the skip columns, the skip path stamps the
// close reason and clears the match columns. Neither strands the other's fields.
//
// Only promotes from NEW. A row already past NEW (SCANNED+, CLOSED, or anything
// the user has since acted on) is left alone, which is what makes re-running the
// scan idempotent — a rate-limit straggler picked up on the next pass can't
// clobber a later state.
//
// SCANNED is deliberately NOT logged as a JobEvent: it's informational and
// high-frequency, and it dominated the per-role timeline. The status-cache flip
// is the whole write. A skip DOES log a CLOSED event — that's a real decision —
// and goes through `logJobEvent` so the event and the status commit together.

import {
  JobCloseReason,
  JobInteractionStatus,
  JobEventType,
  MatchBucket,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { logJobEvent } from "@/server/entities/jobs/logJobEvents";
import type {
  ScanMatchBucket,
  ScanCloseReason,
  ScanJobVerdict,
} from "@/server/subagents/registry/scanJob";

// The sub-agent speaks in plain strings so it never imports the schema; the
// mapping to the Prisma enums lives here, at the domain boundary.
const BUCKETS: Record<ScanMatchBucket, MatchBucket> = {
  STRONG: MatchBucket.STRONG,
  POSSIBLE: MatchBucket.POSSIBLE,
  WEAK: MatchBucket.WEAK,
};
const CLOSE_REASONS: Record<ScanCloseReason, JobCloseReason> = {
  NOT_A_MATCH: JobCloseReason.NOT_A_MATCH,
  LOCATION_MISMATCH: JobCloseReason.LOCATION_MISMATCH,
  OTHER: JobCloseReason.OTHER,
};

export async function applyScanMatch(args: {
  userId: string;
  jobId: string;
  verdict: ScanJobVerdict;
}): Promise<void> {
  const existing = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: args.userId, jobId: args.jobId } },
    select: { id: true, status: true },
  });
  if (existing && existing.status !== JobInteractionStatus.NEW) return;

  if (args.verdict.decision === "skip") {
    await logJobEvent({
      userId: args.userId,
      item: {
        jobId: args.jobId,
        type: JobEventType.CLOSED,
        notes: args.verdict.reason,
        jobInteractionUpdate: {
          status: JobInteractionStatus.CLOSED,
          closeReason: CLOSE_REASONS[args.verdict.closeReason],
          closeNote: args.verdict.reason,
          closeSummaryLabel: args.verdict.summaryLabel ?? null,
          matchBucket: null,
          matchScore: null,
          matchReason: null,
        },
      },
    });
    return;
  }

  // A fresh match verdict supersedes whatever triage the row was carrying, so
  // BOTH prior-decision pairs clear — not just the close one. The defer pair
  // matters because loadShortlistJobsInput reads a pool row's `deferNote` as
  // "the user passed on this in an earlier shortlist round": leaving a stale
  // one behind (a role deferred for some other reason, put back to NEW by
  // update_job_interaction, then re-scanned) would show the ranker a pass that
  // never happened.
  const data = {
    status: JobInteractionStatus.SCANNED,
    matchBucket: BUCKETS[args.verdict.bucket],
    matchScore: args.verdict.score,
    matchReason: args.verdict.reason,
    closeReason: null,
    closeNote: null,
    closeSummaryLabel: null,
    deferReason: null,
    deferNote: null,
  };
  if (existing) {
    await prisma.jobInteraction.update({
      where: { id: existing.id },
      data,
      select: { id: true },
    });
  } else {
    await prisma.jobInteraction.create({
      data: { userId: args.userId, jobId: args.jobId, ...data },
      select: { id: true },
    });
  }
}
