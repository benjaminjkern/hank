// The PRE_SCAN procedure: bulk metadata-only filtering of a company's board at
// watchlist-add / rescan time.
//
// Chain: load the candidate context + the not-yet-judged job pool (see pool.ts)
// → split the pool into chunks → run the chunk sub-agent on each in parallel →
// concatenate their verdicts → close the skipped roles and stamp the survivors.
//
// The sub-agent (subagents/registry/preScanJobBatch.ts) decides which jobs are
// obvious nos and nothing else — it isn't told it's a chunk, and it doesn't
// judge the company. Every step above is here.
//
// **This procedure writes no COMPANY status.** It closes jobs and reports the
// survivors; whoever called it decides what that means for the company, because
// the answer differs by caller: adding a company wants NEW → READY (or
// CAUGHT_UP on a wipe), a re-scrape wants CAUGHT_UP → READY when the delta
// brought something live, and mid-walkthrough the walkthrough's own wrap owns
// the ending. It also cannot CLOSE a company — a metadata-only pass is the
// weakest evidence in the system, and inferring "this whole company is a
// dead-end" from titles alone over-closes. Closing a COMPANY is only ever a
// deliberate user/agent lever; the shortlist closes individual roles it judges
// unapplyable, not companies.
//
// Cold-start bail: with no thesis at all there's nothing to filter against, so
// nothing is closed and nothing is reported as surviving-a-filter. Returns
// mode="cold_start"; the company keeps whatever status it had (NEW at add time)
// and whats_next lands on the top-up-sparse-memory rung next turn.

import type { RunContext, RunTrace } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { passOnJobs } from "@/server/entities/jobs/passOnJobs";
import { withTraceSpan } from "@/server/platform/trace/span";
import { traceText } from "@/server/platform/trace/traceText";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  preScanJobBatchSubAgent,
  type PreScanJobBatchInput,
} from "@/server/subagents/registry/preScanJobBatch";
import { chunk } from "@/utils/array";
import { nowDate } from "@/utils/now";

import { loadPreScanContext, type PreScanContext } from "./loadContext";
import {
  mergeChunkVerdicts,
  type ChunkVerdicts,
  type MergedPreScan,
  type PreScanSkipBucket,
} from "./mergeChunkVerdicts";
import { preScanPoolWhere } from "./pool";

// Split the board into parallel chunks above this size. Each chunk is its own
// sub-agent call sharing the cached thesis/resume prefix; only the job slice
// varies. The sub-agent occasionally emits a verdicts array shorter than a
// large job slice — missing positions default to `keep`, silently inflating
// survivors — so 30 trades ~15% more cache_create overhead for substantially
// more reliable per-chunk output.
const CHUNK_SIZE = 30;

export type PreScanResult =
  | {
      ok: true;
      // "cold_start" = no thesis yet, nothing was filtered or written.
      mode: "ran" | "cold_start";
      skippedJobs: number;
      buckets: number;
      skipBuckets: PreScanSkipBucket[];
      survivingJobIds: string[];
      survivingJobs: number;
      notes: string[];
      turns: number;
    }
  | { ok: false; error: string; turns: number };

type PreScanArgs = RunContext & {
  companyId: string;
  sessionId: string;
  extraContext?: string;
  // Skip every DB write — the LLM still runs and usage is still recorded, so
  // bucketing decisions are real. Used by the audit harness.
  dryRun?: boolean;
  // Supply the context instead of reading it (fixtures, replays). The pool comes
  // with it, so nothing about this run touches the live user's memory or board.
  context?: PreScanContext;
};

export async function runPreScan(args: PreScanArgs): Promise<PreScanResult> {
  return await withTraceSpan(
    "pre_scan",
    args.trace,
    (trace) => preScan({ ...args, trace }),
    (r) =>
      r.ok ? `${r.skippedJobs} skipped, ${r.survivingJobs} survived` : r.error,
  );
}

async function preScan(args: PreScanArgs): Promise<PreScanResult> {
  const context =
    args.context ??
    (await loadPreScanContext({
      userId: args.userId,
      companyId: args.companyId,
    }));
  if (!context) {
    return {
      ok: false,
      error: `no company found for id ${args.companyId}`,
      turns: 0,
    };
  }

  if (!(context.profile ?? "").trim()) {
    return {
      ok: true,
      mode: "cold_start",
      skippedJobs: 0,
      buckets: 0,
      skipBuckets: [],
      survivingJobIds: context.jobs.map((j) => j.id),
      survivingJobs: context.jobs.length,
      notes: [
        "Cold-start: no profile.md yet — bailed without running PRE_SCAN. Nothing closed and no company status written; whats_next will surface the profile rung next turn.",
      ],
      turns: 0,
    };
  }

  const chunks = chunk(context.jobs, CHUNK_SIZE);
  emitStartCaption(args.trace, context, chunks.length);

  const chunkResults = await Promise.all(
    chunks.map(async (jobs) => {
      const input: PreScanJobBatchInput = {
        companyName: context.companyName,
        companyDescription: context.companyDescription,
        companyNote: context.companyNote,
        companyNotePath: context.companyNotePath,
        profile: context.profile ?? "(no profile.md yet)",
        resume: context.resume,
        extraContext: args.extraContext,
        jobs,
        // A supplied context means the whole pool + thesis are already inline —
        // run closed-book so the model can't reach live memory instead.
        closedBook: !!args.context,
      };
      const result = await runSubAgent(preScanJobBatchSubAgent, input, args);
      return { result, jobs };
    }),
  );

  // Any chunk failing bails the whole pass: partially-skip-then-continue mixes
  // signal with noise, and the caller can cheaply retry (nothing is written yet).
  for (const { result } of chunkResults) {
    if (!result.ok) {
      return { ok: false, error: result.error, turns: result.turns };
    }
  }

  const verdicts: ChunkVerdicts[] = chunkResults.map(({ result, jobs }) => ({
    output: result.ok ? result.output : {},
    jobs,
  }));
  const merged = mergeChunkVerdicts(verdicts);
  const turns = chunkResults.reduce((sum, c) => sum + c.result.turns, 0);

  if (!args.dryRun) {
    await passOnSkippedJobs({ userId: args.userId, merged });
    // Stamp what survived, so a scan that dies before reading these doesn't send
    // the next entry back through this pass. Survivors only: a skipped role is
    // CLOSED and out of the pool by status, and a role no chunk reached has to
    // stay reachable. One statement regardless of pool size.
    await prisma.jobInteraction.updateMany({
      where: {
        userId: args.userId,
        jobId: { in: merged.survivingJobIds },
        ...preScanPoolWhere(),
      },
      data: { preScannedAt: nowDate() },
    });
  }

  return {
    ok: true,
    mode: "ran",
    skippedJobs: merged.skippedJobCount,
    buckets: merged.buckets.length,
    skipBuckets: merged.buckets,
    survivingJobIds: merged.survivingJobIds,
    survivingJobs: merged.survivingJobIds.length,
    notes: merged.notes,
    turns,
  };
}

// Propose passing on the skipped roles — the only write pre-scan makes. Every
// bucket in ONE call: they are separate buckets only because they carry
// different reasons, and the write takes a reason per job, so splitting them
// would buy nothing but an extra round trip each.
//
// Nothing is CLOSED here and no event is logged, because nothing has happened to
// these roles yet — the user sees them on the board with the reason, and the
// commit is what closes the ones they leave alone.
async function passOnSkippedJobs(args: {
  userId: string;
  merged: MergedPreScan;
}): Promise<void> {
  const buckets = args.merged.buckets.filter((b) => b.jobs.length > 0);
  if (buckets.length === 0) return;
  await passOnJobs({
    userId: args.userId,
    eliminatedBy: "PRE_SCAN",
    jobs: buckets.flatMap((bucket) =>
      bucket.jobs.map((job) => ({
        id: job.id,
        closeReason: bucket.reason,
        closeNote: job.closeNote,
        closeSummaryLabel: job.closeSummaryLabel,
      })),
    ),
  });
}

function emitStartCaption(
  trace: RunTrace | undefined,
  context: PreScanContext,
  chunkCount: number,
): void {
  const n = context.jobs.length;
  traceText(
    trace,
    chunkCount > 1
      ? `PRE_SCAN: bucketing ${n} jobs at ${context.companyName} across ${chunkCount} parallel chunks…`
      : `PRE_SCAN: bucketing ${n} job${n === 1 ? "" : "s"} at ${context.companyName} against thesis…`,
  );
}
