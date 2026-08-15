// One job through both scan passes: enrich the global Job (cached, user-independent)
// then run the per-user match. Enrichment is idempotent — an already-enriched Job
// short-circuits pass 1, which is what makes a rate-limited run cheap to resume.

import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { readMemory } from "@/server/memory/store";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import { enrichJobSubAgent } from "@/server/subagents/registry/enrichJob";
import { scanJobSubAgent } from "@/server/subagents/registry/scanJob";

import { applyJobEnrichment } from "./applyJobEnrichment";
import { applyScanMatch } from "./applyScanMatch";

import type { ScanContext } from "./loadContext";

export type EnrichmentOutcome = "enriched" | "cached" | "no_body";

export type ScanJobOutcome =
  | { kind: "matched"; enrichment: EnrichmentOutcome }
  | { kind: "skipped"; enrichment: EnrichmentOutcome }
  | { kind: "not_enriched"; enrichment: EnrichmentOutcome }
  | { kind: "error" }
  | { kind: "rate_limited" };

function isRateLimit(status: number | undefined): boolean {
  return status === 429 || status === 529;
}

export async function scanOneJob(
  args: RunContext & {
    jobId: string;
    sessionId: string;
    context: ScanContext;
    // Not optional here: every worker runs under the fan-out's own controller,
    // which is what a rate-limit wall tears down.
    signal: AbortSignal;
    dryRun?: boolean;
  },
): Promise<ScanJobOutcome> {
  const job = await prisma.job.findUnique({
    where: { id: args.jobId },
    select: {
      id: true,
      slug: true,
      title: true,
      ...ROLE_ATTR_SELECT,
      attributes: true,
      enrichedSummary: true,
      enrichedAttributes: true,
      rawContent: true,
      company: { select: { name: true } },
    },
  });
  if (!job) return { kind: "error" };

  // -- pass 1: enrich (cached on the global Job, shared across users) ---------
  let enrichment: EnrichmentOutcome;
  let enrichedSummary = job.enrichedSummary;
  const body = (job.rawContent ?? "").trim();

  if (enrichedSummary && enrichedSummary.trim().length > 0) {
    enrichment = "cached";
  } else if (body.length === 0) {
    // Nothing to enrich from (manually-created job, or a scrape that stored no
    // body). Leave enrichedSummary null so a future re-scrape can enrich.
    enrichment = "no_body";
  } else {
    const enr = await runSubAgent(
      enrichJobSubAgent,
      {
        title: job.title,
        ...toRoleAttrs(job),
        attributes: job.attributes,
        body,
      },
      args,
    );
    if (!enr.ok) {
      return isRateLimit(enr.status)
        ? { kind: "rate_limited" }
        : { kind: "error" };
    }
    if (!args.dryRun) {
      await applyJobEnrichment({
        job: {
          id: job.id,
          locationAndArrangement: job.locationAndArrangement,
          compensation: job.compensation,
          employmentType: job.employmentType,
          department: job.department,
        },
        summary: enr.output.summary,
        scalars: enr.output.scalars,
      });
    }
    enrichedSummary = enr.output.summary;
    enrichment = "enriched";
  }

  // -- pass 2: match (per-user) ----------------------------------------------
  // Reads the enriched summary, not the body. If enrichment didn't run, fall
  // back to the raw body so we still make a call rather than stalling at NEW.
  const roleText = (enrichedSummary ?? "").trim() || body;
  if (roleText.length === 0) {
    // Genuinely nothing to judge (manual job, no body). Leave it for the
    // shortlist to surface from bare metadata.
    return { kind: "not_enriched", enrichment };
  }

  // Anything the user has already said about THIS role. Usually nothing — scan
  // runs on freshly-scraped NEW roles — so it's a cheap read that occasionally
  // carries the one fact that decides the call.
  const jobNotePath = job.slug ? `jobs/${job.slug}.md` : null;
  const jobNote = jobNotePath
    ? await readMemory(args.userId, jobNotePath)
    : null;

  const match = await runSubAgent(
    scanJobSubAgent,
    {
      role: {
        title: job.title,
        companyName: job.company?.name ?? "(company)",
        summary: roleText,
        ...toRoleAttrs(job),
        attributes: job.attributes,
        enrichedAttributes: job.enrichedAttributes,
      },
      profile: args.context.profile,
      resume: args.context.resume,
      companyDescription: args.context.companyDescription,
      companyNote: args.context.companyNote,
      companyNotePath: args.context.companyNotePath,
      jobNote,
      jobNotePath,
    },
    args,
  );
  if (!match.ok) {
    return isRateLimit(match.status)
      ? { kind: "rate_limited" }
      : { kind: "error" };
  }

  if (!args.dryRun) {
    await applyScanMatch({
      userId: args.userId,
      jobId: job.id,
      verdict: match.output,
    });
  }

  return match.output.decision === "match"
    ? { kind: "matched", enrichment }
    : { kind: "skipped", enrichment };
}
