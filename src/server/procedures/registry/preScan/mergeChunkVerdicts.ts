// Merge the per-chunk sub-agent outputs into one company-wide list of jobs to
// close, bucketed by reason.
//
// Pure — no DB, no LLM. Chunking is a fan-out detail of the procedure, so
// stitching the slices back together belongs here rather than in the sub-agent
// (a chunk can't see the other chunks, and deliberately isn't told it is one).
// Nothing here decides a COMPANY status: pre-scan doesn't write one, and its
// callers pick their own from the survivor count.

import type { JobCloseReason } from "@/generated/prisma/client";
import { humanJobCloseReason } from "@/server/entities/jobs/humanJobReasonLabels";
import {
  preScanCloseReason,
  type PreScanJobBatchOutput,
} from "@/server/subagents/registry/preScanJobBatch";

import type { PreScanCandidateJob } from "./loadContext";

// Jobs closed for one reason, each carrying the note the sub-agent wrote for
// THAT job — grouped by reason only because the close write and its summary
// CompanyEvent batch per reason, not because the note is shared.
export type PreScanSkipBucket = {
  reason: JobCloseReason;
  jobs: Array<{
    id: string;
    closeNote: string;
    closeSummaryLabel: string | null;
  }>;
};

export type MergedPreScan = {
  buckets: PreScanSkipBucket[];
  survivingJobIds: string[];
  skippedJobCount: number;
  // Operator-facing notes about anything the merge had to paper over. Surfaced
  // in the procedure's result so an oddity is visible rather than silent.
  notes: string[];
};

// One chunk's output paired with the jobs it was asked about, in the order they
// were shown — `verdicts[i]` decides `jobs[i]`.
export type ChunkVerdicts = {
  output: PreScanJobBatchOutput;
  jobs: PreScanCandidateJob[];
};

export function mergeChunkVerdicts(chunks: ChunkVerdicts[]): MergedPreScan {
  const notes: string[] = [];
  const jobsByReason = new Map<
    JobCloseReason,
    Array<{ id: string; closeNote: string; closeSummaryLabel: string | null }>
  >();

  let underfilledChunks = 0;
  let missingRationales = 0;
  for (const chunk of chunks) {
    const verdicts = chunk.output.verdicts ?? [];
    if (verdicts.length !== chunk.jobs.length) underfilledChunks++;

    for (let i = 0; i < chunk.jobs.length; i++) {
      // A position the model didn't fill — or filled with a verdict outside the
      // vocabulary — defaults to `keep`, never to a skip: an under-filled array
      // must not silently close a job nobody judged.
      const closeReason = preScanCloseReason(verdicts[i]?.verdict);
      if (!closeReason) continue;

      // The sub-agent is required to write the rationale before the verdict, so
      // a skip without one means it broke its own schema — fall back to the
      // reason label rather than showing the user an empty note.
      const rationale = verdicts[i]?.rationale?.trim();
      if (!rationale) missingRationales++;

      const jobs = jobsByReason.get(closeReason) ?? [];
      jobs.push({
        id: chunk.jobs[i].id,
        closeNote: rationale || humanJobCloseReason(closeReason),
        closeSummaryLabel: verdicts[i]?.summaryLabel?.trim() || null,
      });
      jobsByReason.set(closeReason, jobs);
    }
  }
  if (underfilledChunks > 0) {
    notes.push(
      `PRE_SCAN ${underfilledChunks} chunk(s) returned a verdicts array of unexpected length; missing positions defaulted to keep.`,
    );
  }
  if (missingRationales > 0) {
    notes.push(
      `PRE_SCAN ${missingRationales} skip verdict(s) came back with no rationale; used the close-reason label as the note.`,
    );
  }

  const buckets: PreScanSkipBucket[] = Array.from(jobsByReason).map(
    ([reason, jobs]) => ({ reason, jobs }),
  );

  const allJobIds = chunks.flatMap((c) => c.jobs.map((j) => j.id));
  const skippedJobIds = new Set(
    buckets.flatMap((b) => b.jobs.map((j) => j.id)),
  );
  const survivingJobIds = allJobIds.filter((id) => !skippedJobIds.has(id));

  return {
    buckets,
    survivingJobIds,
    skippedJobCount: skippedJobIds.size,
    notes,
  };
}
