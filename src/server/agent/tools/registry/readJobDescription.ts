import { z } from "zod";

import { prisma } from "@/server/db/prisma";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const readJobDescriptionTool: ToolDef<{ job: string }> = {
  name: "read_job_description",
  // Auto-promotes the JobInteraction NEW/PITCHED → SCANNED and logs a SCANNED
  // event, so the status pill + dashboard counts change. Tag for mid-turn
  // refresh; the 300ms debounce coalesces a rapid run of scans into one refetch.
  affectsViewedState: true,
  description:
    "Return the full posting content (rawContent) for a single role by its slug. The text comes from the DB — don't fetch_url the sourceUrl again, you already have it. Side effects: logs a SCANNED event, and **auto-promotes the JobInteraction NEW → SCANNED (and PITCHED → SCANNED)** — the act of reading the description is what SCANNED means. Don't set the status yourself afterward — it's done for you. Does NOT rescue CLOSED rows: if you mistakenly skipped a job and want to reconsider, log a SHORTLISTED event (log_job_events([{type:'SHORTLISTED'}])) first; that's the intentional path so the skip reversal lands as its own audit event. This tool intentionally does NOT fetch application form questions — that's view_application_questions, called later when you're actually about to draft for a shortlisted job. To read a role's event timeline (applied / interviewed / skipped etc.) WITHOUT loading the whole posting, use list_job_events instead.",
  inputSchema: {
    type: "object",
    properties: { job: { type: "string", description: "The role's slug." } },
    required: ["job"],
  },
  parser: z.object({ job: z.string() }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobBySlug(ctx.userId, input.job);
    if (!jobResolved.ok) {
      return slugLookupError(jobResolved, { source: "read_job_description" });
    }
    const jobId = jobResolved.value.id;
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        sourceUrl: true,
        rawContent: true,
        companyName: true,
        company: { select: { name: true } },
      },
    });
    if (!job) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no job found for "${input.job}".`,
        "read_job_description:not_found:job",
      );
    }

    const companyLabel =
      job.company?.name ?? job.companyName ?? "(no company attached)";
    const headerLines = [`# ${job.title}`, `Company: ${companyLabel}`];
    if (job.sourceUrl) headerLines.push(`URL: ${job.sourceUrl}`);
    const body =
      job.rawContent && job.rawContent.trim().length > 0
        ? job.rawContent
        : "(no posting content stored — this job was added manually from chat. Use update_job to add a description if you have one.)";
    return {
      content: `${headerLines.join("\n")}\n\n${body}`,
    };
  },
};
