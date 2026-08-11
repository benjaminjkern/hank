// scrape_jobs_for_company procedure — the orchestration behind the
// scrapeJobsForCompanyTool. Pulls a watchlisted company's live board (via the
// shared scrapeJobsForCompany core), triages the genuinely-new postings with
// PRE_SCAN, and shows the company so the right panel reflects the outcome.
//
// The tool is handoff: true, so once it returns the deterministic layer owns
// what shows next: in a walkthrough the state machine scans the new survivors;
// in the default flow the turn simply ends — which is why the PRE_SCAN here is
// load-bearing (nothing else triages the delta when no state machine follows).
// See scrapeJobsForCompany.ts for the handoff rationale.
//
// Gates (not on the watchlist / CLOSED / no careers URL) reject up front. A
// scrape failure is NOT one of them: it comes back as a normal outcome ("board
// unchanged") so Hank can relay it — the company keeps whatever roles are
// already on file.
//
// The result carries what happened, never how it reads: the tool owns every
// agent-facing sentence and the ToolErrorCode each gate maps to. The company's
// name is deliberately absent — the caller resolved it by slug and already has
// it.

import { CompanyStatus } from "@/generated/prisma/client";
import type { RunContext, UiEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { markCompanyPostFilter } from "@/server/entities/companies/markCompanyStatus";
import { syncCompanyBoard } from "@/server/entities/jobs/syncCompanyBoard";
import { runPreScan } from "@/server/procedures/registry/preScan";
import { runReconBoard } from "@/server/procedures/registry/reconBoard";
import type { ReconBoardResult } from "@/server/procedures/registry/reconBoard";
import type { ScrapeFailureKind } from "@/server/scrape/types";
import { buildShowEvents } from "@/server/views/showEvents";

const TIMEOUT_MS = 90_000;
// Recon's own budget, spent OUTSIDE the scrape's. It's an LLM loop with a
// read-tool that fetches, so it belongs to a different cost class than the
// fetch-sized window above.
const RECON_TIMEOUT_MS = 120_000;
// The two failures a better read-plan could fix. An upstream blip is not one of
// them and must never buy an LLM call.
const RECON_WORTHY_FAILURES = new Set<ScrapeFailureKind>([
  "no_reader",
  "reader_broken",
]);

export type ScrapeJobsForCompanyArgs = RunContext & {
  sessionId: string;
  companyId: string;
  extraContext?: string;
};

// How the PRE_SCAN pass over the new postings went. "cold_start" = no thesis
// yet, so nothing was filtered.
export type PreScanOutcome =
  | { kind: "failed"; error: string }
  | { kind: "cold_start" }
  | {
      kind: "ran";
      skippedJobs: number;
      buckets: number;
      survivingJobs: number;
    };

export type ScrapeOutcome =
  | {
      kind: "scrape_failed";
      error: string;
      // Whether a better read-plan could plausibly fix this, or it was just a
      // bad minute on someone else's server. Carried as a discriminator rather
      // than inferred from `error`, so nothing has to pattern-match prose to
      // decide whether to spend an LLM call.
      failureKind: ScrapeFailureKind;
      // What recon concluded, when the failure was worth escalating. Absent
      // means it wasn't worth an LLM call, or the cooldown was still running.
      recon?: ReconBoardResult;
    }
  | {
      kind: "no_delta";
      totalJobs: number;
      truncatedAt?: number;
      priorStatus: CompanyStatus;
      learned: boolean;
      missingNotDelisted: number;
    }
  | {
      kind: "scraped";
      newJobInteractions: number;
      totalJobs: number;
      // Postings that came down off the board this pass.
      delistedJobs: number;
      // Postings missing from the board that were deliberately NOT delisted —
      // a learned reader read this board, and closure is terminal and global.
      // The caller must say so: silence here reads as "nothing changed".
      missingNotDelisted: number;
      // This board was read by an inferred plan, not a hand-written provider.
      learned: boolean;
      // Set when the board came back partial (provider cap or a dropped detail
      // fetch). Both success outcomes carry it because "12 roles" and "12 of
      // 1078 roles" are different facts, and the agent phrases them differently.
      truncatedAt?: number;
      scrapeStartedAt: Date;
      preScan: PreScanOutcome;
    };

export type ScrapeJobsForCompanyResult =
  | { ok: false; kind: "not_on_watchlist" }
  | { ok: false; kind: "company_closed"; closeReason: string | null }
  | { ok: false; kind: "no_source_url" }
  // The timeout or an exception from any step below it.
  | { ok: false; kind: "failed"; error: string }
  | { ok: true; outcome: ScrapeOutcome; events: UiEvent[] };

export async function runScrapeJobsForCompany(
  args: ScrapeJobsForCompanyArgs,
): Promise<ScrapeJobsForCompanyResult> {
  const companyInteraction = await prisma.companyInteraction.findUnique({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    include: { company: true },
  });
  if (!companyInteraction) {
    return { ok: false, kind: "not_on_watchlist" };
  }
  if (companyInteraction.status === CompanyStatus.CLOSED) {
    return {
      ok: false,
      kind: "company_closed",
      closeReason: companyInteraction.closeReason,
    };
  }
  const sourceUrl = companyInteraction.company.sourceUrl;
  if (!sourceUrl) {
    return { ok: false, kind: "no_source_url" };
  }

  const driveArgs = {
    ...args,
    company: companyInteraction.company,
    priorStatus: companyInteraction.status,
  };

  const first = await raceDrive(driveArgs);

  // The board is unreadable in a way a better plan could fix. Recon runs
  // OUTSIDE the scrape's timeout with its own budget, because it's a different
  // kind of work — an LLM loop, not a fetch — and squeezing it into a window
  // sized for HTTP would guarantee it never finishes.
  if (
    first.ok &&
    first.outcome.kind === "scrape_failed" &&
    RECON_WORTHY_FAILURES.has(first.outcome.failureKind)
  ) {
    const recon = await raceRecon({
      ...args,
      companyId: companyInteraction.company.id,
      companyName: companyInteraction.company.name,
      sourceUrl,
    });
    if (recon?.kind === "learned") {
      const retried = await raceDrive(driveArgs);
      // Only take the retry if it actually worked — a second failure should
      // report the original problem, not "we tried again and it broke too".
      if (retried.ok && retried.outcome.kind !== "scrape_failed")
        return retried;
    }
    if (recon) {
      return {
        ...first,
        outcome: { ...first.outcome, recon },
      };
    }
  }

  return first;
}

async function raceDrive(
  args: Parameters<typeof drive>[0],
): Promise<ScrapeJobsForCompanyResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      drive(args),
      new Promise<ScrapeJobsForCompanyResult>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`scrape timed out after ${TIMEOUT_MS / 1000}s`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    return {
      ok: false,
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function raceRecon(
  args: RunContext & {
    companyId: string;
    companyName: string;
    sourceUrl: string;
  },
): Promise<ReconBoardResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runReconBoard(args),
      new Promise<ReconBoardResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("recon timed out")),
          RECON_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    // A recon that times out is not a verdict about the board — report the
    // original scrape failure unchanged.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drive(
  args: ScrapeJobsForCompanyArgs & {
    company: { id: string; name: string; sourceUrl: string | null };
    priorStatus: CompanyStatus;
  },
): Promise<ScrapeJobsForCompanyResult> {
  const scraped = await syncCompanyBoard({
    userId: args.userId,
    companyId: args.company.id,
    sourceUrl: args.company.sourceUrl!,
    signal: args.signal,
  });

  // Show the company regardless of outcome so the panel reflects the scrape.
  const { events } = await buildShowEvents(args.userId, {
    companyId: args.company.id,
  });

  if (!scraped.ok) {
    return {
      ok: true,
      outcome: {
        kind: "scrape_failed",
        error: scraped.error,
        failureKind: scraped.kind,
      },
      events,
    };
  }

  if (scraped.newJobInteractions === 0) {
    // No delta — same board, same outcome. Don't flip status; the user (or a
    // future scrape) decides whether to look again.
    return {
      ok: true,
      outcome: {
        kind: "no_delta",
        totalJobs: scraped.totalJobs,
        ...(scraped.truncatedAt != null
          ? { truncatedAt: scraped.truncatedAt }
          : {}),
        priorStatus: args.priorStatus,
        learned: scraped.learned,
        missingNotDelisted: scraped.missingNotDelisted,
      },
      events,
    };
  }

  // Delta exists — run PRE_SCAN pt1 on just the arrivals. PRE_SCAN's own query
  // is scoped to what it hasn't judged yet, so this is naturally delta-scoped:
  // rows it kept on an earlier pass carry a `preScannedAt` stamp and are skipped
  // along with everything already scanned / applied to.
  // PRE_SCAN writes no company status, so the flip is this seam's: survivors in
  // the delta revive a CAUGHT_UP company to READY, a delta that all skipped puts
  // it back to CAUGHT_UP. Neither demotes a company that's past those states
  // (markCompanyPostFilter only overwrites the pre-walkthrough set — APPLYING
  // stays put).
  const preScan = await runPreScan({ ...args, companyId: args.company.id });
  if (preScan.ok && preScan.mode === "ran") {
    await markCompanyPostFilter(
      args.company.id,
      args.userId,
      preScan.survivingJobs,
    );
  }

  // No pt2/deep-check — the per-job scan step (enrich + match) runs in the
  // walkthrough when the user works the company, reading bodies there.
  return {
    ok: true,
    outcome: {
      kind: "scraped",
      newJobInteractions: scraped.newJobInteractions,
      totalJobs: scraped.totalJobs,
      delistedJobs: scraped.delistedJobs,
      missingNotDelisted: scraped.missingNotDelisted,
      learned: scraped.learned,
      ...(scraped.truncatedAt != null
        ? { truncatedAt: scraped.truncatedAt }
        : {}),
      scrapeStartedAt: scraped.scrapeStartedAt,
      preScan: !preScan.ok
        ? { kind: "failed", error: preScan.error }
        : preScan.mode === "cold_start"
          ? { kind: "cold_start" }
          : {
              kind: "ran",
              skippedJobs: preScan.skippedJobs,
              buckets: preScan.buckets,
              survivingJobs: preScan.survivingJobs,
            },
    },
    events,
  };
}
