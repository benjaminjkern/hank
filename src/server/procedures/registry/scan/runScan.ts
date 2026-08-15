// The SCAN procedure's fan-out: for every prescan survivor (NEW JobInteraction) at
// one company, run scanOneJob (enrich then per-user match) and fold the outcomes.
//
// Fan-out discipline:
//   - Concurrency capped so we don't slam the rate limit.
//   - On a 429/529 wall we ABORT the in-flight batch (chained AbortController)
//     and return `rateLimited`. We do NOT retry into the wall — the SDK already
//     backed off. Resumption is free: enrichment is cached on the Job and the
//     match pass only touches NEW rows, so the next pass finishes the leftovers.
//   - A per-job error (not a rate limit) is non-fatal: we leave that job NEW and
//     a final sweep bumps it to SCANNED so the shortlist (which falls back to
//     rawContent) still sees it — no job gets stranded in NEW limbo.

import { JobInteractionStatus } from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { withTraceSpan } from "@/server/platform/trace/span";
import { isUserAbortError } from "@/utils/abort";

import { loadScanContext } from "./loadContext";
import { scanOneJob, type ScanJobOutcome } from "./scanOneJob";

// Max jobs scanned concurrently. Each worker does its job's enrich→match as two
// sequential calls, so this is also the ceiling on in-flight LLM requests. 16
// means a typical survivor pool (≤~20) clears in roughly one wave; it's a
// ceiling, not a target. We keep a cap rather than going unbounded so a
// 200-survivor board can't fire 200 concurrent calls into a rate limit.
const CONCURRENCY = 16;

export type RunScanResult = {
  ok: true;
  total: number; // NEW survivors at start
  matched: number; // → SCANNED with a bucket
  skipped: number; // → PASS stance proposed (closed only when the board commits)
  enriched: number; // enrich cache misses (newly computed)
  cached: number; // enrich cache hits
  errors: number; // non-fatal per-job failures
  rateLimited: boolean; // hit a 429/529 wall; remainder left NEW for next pass
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
      `${r.matched} matched, ${r.skipped} skipped, ${r.errors} error${r.errors === 1 ? "" : "s"}${r.rateLimited ? " (rate-limited)" : ""}`,
  );
}

async function scan(args: ScanArgs): Promise<RunScanResult> {
  const survivors = await prisma.jobInteraction.findMany({
    where: {
      userId: args.userId,
      status: JobInteractionStatus.NEW,
      job: { companyId: args.companyId },
    },
    select: { jobId: true },
  });
  const jobIds = survivors.map((s) => s.jobId);

  const result: RunScanResult = {
    ok: true,
    total: jobIds.length,
    matched: 0,
    skipped: 0,
    enriched: 0,
    cached: 0,
    errors: 0,
    rateLimited: false,
  };
  if (jobIds.length === 0) return result;

  const context = await loadScanContext(args.userId, args.companyId);

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
      else if (outcome.kind === "skipped") result.skipped++;
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

  // No company-feed event here: a skip is a PROPOSED pass, not a close — the
  // commit is what closes rows, and its SHORTLIST_RAN event carries the real
  // outcome. Writing "Closed N roles" at scan time put a decision in the feed
  // that nothing had made yet.
  if (!args.dryRun) {
    // Final sweep: when we finished cleanly (not a rate-limit abort), promote any
    // job still NEW (errored, or no body to match on) to SCANNED so the shortlist
    // rollup considers it instead of leaving it stranded. Eventless bump.
    if (!result.rateLimited) {
      await prisma.jobInteraction.updateMany({
        where: {
          userId: args.userId,
          status: JobInteractionStatus.NEW,
          job: { companyId: args.companyId },
        },
        data: { status: JobInteractionStatus.SCANNED },
      });
    }
  }

  return result;
}
