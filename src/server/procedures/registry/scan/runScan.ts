// The SCAN procedure's fan-out: for every unjudged NEW role at one company
// (scanPoolWhere — prescan's PASS-stanced rows are already judged and excluded),
// run scanOneJob (enrich then per-user match) and fold the outcomes.
//
// Fan-out discipline:
//   - Concurrency capped so we don't slam the rate limit.
//   - On a 429/529 wall we ABORT the in-flight batch (chained AbortController)
//     and return `rateLimited`. We do NOT retry into the wall — the SDK already
//     backed off. Resumption is free: enrichment is cached on the Job and the
//     match pass only touches unstanced NEW rows, so the next pass finishes the
//     leftovers.
//   - Approaching the run's `deadlineAt`, workers stop claiming new jobs and we
//     return `timedOut` — same resumable shape as the rate-limit wall, so a
//     board too big for one run ends with a clean partial instead of the cap
//     ripping the fan-out mid-flight.
//   - A per-job error (not a rate limit) is non-fatal: we leave that job NEW and
//     a final sweep bumps it to SCANNED so the shortlist (which falls back to
//     rawContent) still sees it — no job gets stranded in NEW limbo.

import {
  JobInteractionStatus,
  CompanyEventType,
  type JobCloseReason,
} from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { logCompanyEvents } from "@/server/entities/companies/logCompanyEvent";
import { humanJobCloseReason } from "@/server/entities/jobs/humanJobReasonLabels";
import { withTraceSpan } from "@/server/platform/trace/span";
import type { ScanCloseReason } from "@/server/subagents/registry/scanJob";
import { isUserAbortError } from "@/utils/abort";
import { nowMs } from "@/utils/now";

import { loadScanContext } from "./loadContext";
import { scanPoolWhere } from "./pool";
import { scanOneJob, type ScanJobOutcome } from "./scanOneJob";

// Max jobs scanned concurrently. Each worker does its job's enrich→match as two
// sequential calls, so this is also the ceiling on in-flight LLM requests. 16
// means a typical survivor pool (≤~20) clears in roughly one wave; it's a
// ceiling, not a target. We keep a cap rather than going unbounded so a
// 200-survivor board can't fire 200 concurrent calls into a rate limit.
const CONCURRENCY = 16;

export type RunScanResult = {
  ok: true;
  total: number; // pool size at start (scanPoolWhere)
  matched: number; // → SCANNED with a bucket
  skipped: number; // → proposed PASS stance (the commit closes it)
  enriched: number; // enrich cache misses (newly computed)
  cached: number; // enrich cache hits
  errors: number; // non-fatal per-job failures
  rateLimited: boolean; // hit a 429/529 wall; remainder left NEW for next pass
  timedOut: boolean; // ran out of run budget; remainder left NEW for next pass
};

type ScanArgs = RunContext & {
  companyId: string;
  sessionId: string;
  dryRun?: boolean;
};

export async function runScan(args: ScanArgs): Promise<RunScanResult> {
  return await withTraceSpan(
    "scan",
    args.trace,
    (trace) => scan({ ...args, trace }),
    (r) =>
      `${r.matched} matched, ${r.skipped} skipped, ${r.errors} error${r.errors === 1 ? "" : "s"}${r.rateLimited ? " (rate-limited)" : ""}${r.timedOut ? " (out of run budget)" : ""}`,
  );
}

// Stop claiming new jobs this long before the run's deadline: enough for the
// in-flight wave (a worker's enrich + match are two sequential calls) to land
// and for the walkthrough to narrate the partial before the cap aborts.
const DEADLINE_MARGIN_MS = 60_000;

async function scan(args: ScanArgs): Promise<RunScanResult> {
  const pool = await prisma.jobInteraction.findMany({
    where: {
      userId: args.userId,
      job: { companyId: args.companyId },
      ...scanPoolWhere(),
    },
    select: { jobId: true },
  });
  const jobIds = pool.map((s) => s.jobId);

  const result: RunScanResult = {
    ok: true,
    total: jobIds.length,
    matched: 0,
    skipped: 0,
    enriched: 0,
    cached: 0,
    errors: 0,
    rateLimited: false,
    timedOut: false,
  };
  if (jobIds.length === 0) return result;

  const context = await loadScanContext(args.userId, args.companyId);

  // Per-reason skip tally → one collapsed JOBS_CLOSED company event per reason
  // (the per-job CLOSED JobEvents still fan out inside applyScanMatch).
  const skipReasonCounts = new Map<ScanCloseReason, number>();

  // Internal controller chained to the caller's Stop signal so a rate-limit wall
  // (or a user Stop) tears down in-flight sub-agent calls promptly.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener("abort", onAbort, { once: true });
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    // `cursor++` is read-then-incremented with no await between, so it's a safe
    // atomic claim under the single-threaded event loop.
    while (!controller.signal.aborted) {
      // Out of run budget → stop claiming; in-flight siblings finish and land.
      // No abort: unlike a rate-limit wall there's nothing wrong with the work,
      // we just can't START more of it and still end the run cleanly.
      if (
        args.deadlineAt !== undefined &&
        nowMs() > args.deadlineAt - DEADLINE_MARGIN_MS
      ) {
        result.timedOut = true;
        return;
      }
      const idx = cursor++;
      if (idx >= jobIds.length) return;

      let outcome: ScanJobOutcome;
      try {
        // eslint-disable-next-line no-await-in-loop -- this await IS the concurrency limit: N workers draining a shared cursor is how the pool stays bounded
        outcome = await scanOneJob({
          jobId: jobIds[idx],
          userId: args.userId,
          sessionId: args.sessionId,
          context,
          trace: args.trace,
          signal: controller.signal,
          dryRun: args.dryRun,
        });
      } catch (err) {
        // A sub-agent re-throws an abort so a user Stop reads as a real stop
        // rather than a recoverable failure. Here the abort is usually OUR OWN —
        // a sibling worker hit a rate-limit wall and tore the batch down — and
        // the partial result still has to come back with `rateLimited` set, so
        // this worker just stands down. A user Stop lands in the same place:
        // scanning is resumable, and what already landed is worth returning.
        if (isUserAbortError(err)) return;
        throw err;
      }

      if (outcome.kind === "rate_limited") {
        result.rateLimited = true;
        controller.abort();
        return;
      }
      if (outcome.kind === "error") {
        result.errors++;
        continue; // leave NEW; final sweep bumps it to SCANNED
      }
      if (outcome.enrichment === "enriched") result.enriched++;
      else if (outcome.enrichment === "cached") result.cached++;

      if (outcome.kind === "matched") result.matched++;
      else if (outcome.kind === "skipped") {
        result.skipped++;
        // No await between get and set, so concurrent workers can't race here.
        skipReasonCounts.set(
          outcome.closeReason,
          (skipReasonCounts.get(outcome.closeReason) ?? 0) + 1,
        );
      }
      // kind === "not_enriched": no body to judge — leave NEW; the final sweep
      // promotes it to SCANNED so the shortlist sees it from metadata.
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobIds.length) }, () =>
      worker(),
    ),
  );

  if (args.signal) args.signal.removeEventListener("abort", onAbort);

  if (!args.dryRun) {
    // One collapsed company-feed row per skip reason (best-effort), all inserted
    // together rather than a round trip per reason.
    await logCompanyEvents(
      [...skipReasonCounts].map(([reason, count]) => ({
        userId: args.userId,
        companyId: args.companyId,
        type: CompanyEventType.JOBS_CLOSED,
        notes: `Closed ${count} role${count === 1 ? "" : "s"}: ${humanJobCloseReason(reason as JobCloseReason)}`,
      })),
    );

    // Final sweep: ONLY when the pool was actually drained — promote any job
    // still in it (errored, or no body to match on) to SCANNED so the shortlist
    // rollup considers it instead of leaving it stranded. Eventless bump. A
    // partial exit (rate-limit wall, run budget, Stop) must NOT sweep: the
    // leftovers were never read, and SCANNED would tell the shortlist they were.
    const drained =
      !result.rateLimited && !result.timedOut && !controller.signal.aborted;
    if (drained) {
      await prisma.jobInteraction.updateMany({
        where: {
          userId: args.userId,
          job: { companyId: args.companyId },
          ...scanPoolWhere(),
        },
        data: { status: JobInteractionStatus.SCANNED },
      });
    }
  }

  return result;
}
