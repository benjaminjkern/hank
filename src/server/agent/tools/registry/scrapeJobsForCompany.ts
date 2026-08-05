// scrape_jobs_for_company tool — a thin wrapper over runScrapeJobsForCompany.
// Resolves the company slug, then delegates the whole scrape → triage → focus
// sequence to the procedure, which shares its scrape→persist core
// (scrapeJobsForCompany) with the walkthrough's on-entry board refresh. The
// procedure reports what happened; the wording of every agent-facing sentence,
// and which ToolErrorCode each rejected gate maps to, are this file's.
//
// handoff: true — this is Hank's EXPLICIT hand-off to the deterministic layer.
// Pulling new postings should feed them into scan + shortlist, and per the
// "nothing runs unless Hank hands off" invariant (AGENTS.md) that continuation
// must be a tool Hank knowingly calls, not a re-derivation that fires behind his
// back after a quiet turn. Ending the loop here lets the walkthrough state
// machine take over and scan the new survivors (narrated). In the default flow
// (no state machine) the turn simply ends after the scrape — the procedure's own
// PRE_SCAN already triaged the delta, and Hank's pre-call narration already told
// the user what he's doing.

import { z } from "zod";

import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import {
  runScrapeJobsForCompany,
  type PreScanOutcome,
  type ScrapeOutcome,
} from "@/server/procedures/registry/scrapeJobsForCompany";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef, ToolResult } from "../lib/types";

const PARSER = z.object({
  company: z.string().min(1),
  context: z.string().optional(),
});

export const scrapeJobsForCompanyTool: ToolDef<z.infer<typeof PARSER>> = {
  name: "scrape_jobs_for_company",
  description:
    'Scrape a watchlist company\'s live job board and pick up anything new. Re-scrapes the careers page, diffs against the postings already on file, runs the cheap first-pass filter on the new ones, and — in a walkthrough — the survivors flow straight into the normal read-and-shortlist. Use this whenever the user wants a company\'s current roles or thinks something was missed: "any new postings?", "did you miss anything?", "look again", "check Stripe again". It is the ONLY way to bring in postings that weren\'t scraped before — company_walkthrough just opens/resumes a company from the roles already on file and does NOT re-scrape the board. Requires a careers URL already on file (set one with update_company; for a brand-new company use create_companies). It can\'t surface roles that aren\'t actually posted — if the board genuinely has few, that\'s the real count, not a failure. Takes ~5-30s.',

  handoff: true,
  affectsViewedState: true,
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "Company slug (e.g. 'stripe')." },
      context: {
        type: "string",
        description:
          "Optional one-sentence steering for the new postings' first-pass filter (e.g. 'user just said IC only this round').",
      },
    },
    required: ["company"],
  },
  parser: PARSER,
  async handle(input, ctx): Promise<ToolResult> {
    const r = await resolveCompanyBySlug(ctx.userId, input.company);
    if (!r.ok) return slugLookupError(r);
    const name = r.value.name;
    const result = await runScrapeJobsForCompany({
      ...ctx,
      companyId: r.value.id,
      extraContext: input.context,
    });

    if (!result.ok) {
      switch (result.kind) {
        case "not_on_watchlist":
          return toolError(
            "ENTITY_NOT_FOUND",
            `company ${name} is not on the watchlist — add it via create_companies first.`,
            "scrape_jobs_for_company:not_found:watchlist_entry",
          );
        case "company_closed":
          return toolError(
            "GATE_BLOCKED",
            `company ${name} is CLOSED (${result.closeReason ?? "no reason"}). Revive it via company_walkthrough first if you want to scrape its board.`,
            "scrape_jobs_for_company:gate:company_closed",
          );
        case "no_source_url":
          return toolError(
            "GATE_BLOCKED",
            `company ${name} has no careers URL on file. Use update_company to supply one before scraping its board.`,
            "scrape_jobs_for_company:gate:no_source_url",
          );
        case "failed":
          return toolError(
            "DISPATCH_ERROR",
            `scrape_jobs_for_company failed: ${result.error}`,
            "scrape_jobs_for_company:exception",
          );
      }
    }

    // Threaded so the walkthrough state machine scans/shortlists the new
    // survivors for this company (instead of reading the focus slot).
    return {
      content: describeOutcome(name, result.outcome),
      events: result.events,
      entryTarget: { kind: "company", id: r.value.id },
    };
  },
};

// A scrape that failed or found nothing is a normal outcome, not a tool error —
// Hank relays it and the company keeps the roles already on file.
function describeOutcome(name: string, outcome: ScrapeOutcome): string {
  switch (outcome.kind) {
    case "scrape_failed":
      return `scrape of ${name} failed: ${outcome.error}. Company unchanged — it keeps the roles already on file.`;
    case "no_delta":
      return `scrape ${name}: no new postings since last scrape (board had ${outcome.totalJobs} job${outcome.totalJobs === 1 ? "" : "s"}). Status unchanged (${outcome.priorStatus}).`;
    case "scraped":
      return [
        `scrape ${name}: ${outcome.newJobInteractions} new posting${outcome.newJobInteractions === 1 ? "" : "s"} (total ${outcome.totalJobs} on board)`,
        describePreScan(outcome.preScan),
        `lastScrapedJobsAt=${outcome.scrapeStartedAt.toISOString()}`,
      ].join("\n");
  }
}

function describePreScan(preScan: PreScanOutcome): string {
  switch (preScan.kind) {
    case "failed":
      return `PRE_SCAN pt1 failed: ${preScan.error}`;
    case "cold_start":
      return `PRE_SCAN pt1: cold-start bail (no thesis yet)`;
    case "ran":
      return `PRE_SCAN pt1: ${preScan.skippedJobs} skipped across ${preScan.buckets} bucket${preScan.buckets === 1 ? "" : "s"}; survivors=${preScan.survivingJobs}; company → ${preScan.survivingJobs > 0 ? "READY" : "CAUGHT_UP"}`;
  }
}
