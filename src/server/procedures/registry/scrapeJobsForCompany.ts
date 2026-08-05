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
import { buildShowEvents } from "@/server/views/showEvents";

const TIMEOUT_MS = 90_000;

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
  | { kind: "scrape_failed"; error: string }
  | { kind: "no_delta"; totalJobs: number; priorStatus: CompanyStatus }
  | {
      kind: "scraped";
      newJobInteractions: number;
      totalJobs: number;
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
  if (!companyInteraction.company.sourceUrl) {
    return { ok: false, kind: "no_source_url" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      drive({
        ...args,
        company: companyInteraction.company,
        priorStatus: companyInteraction.status,
      }),
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
      outcome: { kind: "scrape_failed", error: scraped.error },
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
        priorStatus: args.priorStatus,
      },
      events,
    };
  }

  // Delta exists — run PRE_SCAN pt1 on just the new (NEW-status) JobInteractions.
  // PRE_SCAN's own job query filters by status=NEW so this is naturally
  // delta-scoped (existing scanned/skipped/applied JobInteractions are untouched).
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
