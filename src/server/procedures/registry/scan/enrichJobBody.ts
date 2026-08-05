// Second entry into the scan procedure: enrich ONE job's body without running
// the per-user match pass. The reconsider path uses it — putting a never-read
// role back in play needs the summary (that's what the board and the ranker
// discuss), but the human contesting the pipeline's judgment IS the judgment,
// so re-running the match to argue back would be noise.

import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import {
  toRoleAttrs,
  ROLE_ATTR_SELECT,
} from "@/server/entities/jobs/roleAttrs";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import { enrichJobSubAgent } from "@/server/subagents/registry/enrichJob";

import { applyJobEnrichment } from "./applyJobEnrichment";

export type EnrichJobBodyOutcome = "enriched" | "cached" | "no_body" | "error";

export async function runEnrichJobBody(
  args: RunContext & { jobId: string },
): Promise<EnrichJobBodyOutcome> {
  const job = await prisma.job.findUnique({
    where: { id: args.jobId },
    select: {
      id: true,
      title: true,
      ...ROLE_ATTR_SELECT,
      attributes: true,
      enrichedSummary: true,
      rawContent: true,
    },
  });
  if (!job) return "error";
  if (job.enrichedSummary && job.enrichedSummary.trim().length > 0) {
    return "cached";
  }
  const body = (job.rawContent ?? "").trim();
  if (body.length === 0) return "no_body";

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
  if (!enr.ok) return "error";
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
  return "enriched";
}
