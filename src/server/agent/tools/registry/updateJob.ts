import { z } from "zod";

import { updateJob } from "@/server/entities/jobs/updateJob";
import {
  resolveCompanyBySlug,
  resolveJobBySlug,
} from "@/server/entities/resolveBySlug";
import { normalizeUrlInput } from "@/utils/url";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const updateJobTool: ToolDef<{
  job: string;
  company?: string | null;
  companyName?: string | null;
  title?: string;
  sourceUrl?: string | null;
  rawContent?: string | null;
  location?: string | null;
  department?: string | null;
  compensation?: string | null;
  employmentType?: string | null;
}> = {
  name: "update_job",
  affectsViewedState: true,
  description:
    "Update an existing Job's fields. `job` is the job slug (from list_jobs). Use to clean up a messy scrape, fill in details, correct a sourceUrl, or attach a previously-unaffiliated pitched role to a real Company once it's on the watchlist (set `company` to the company slug; the tool auto-clears `companyName`). Pass null on a nullable field to clear it (`company: null` detaches). Does not change JobInteraction status — use log_job_events / close_job / mark_job_applied for that.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The job slug to update." },
      company: {
        type: ["string", "null"],
        description:
          "Set to a company slug to link this Job. A non-null value auto-clears `companyName`. Null detaches.",
      },
      companyName: {
        type: ["string", "null"],
        description:
          "Human-readable company name when `company` is null. Ignored if `company` is currently set.",
      },
      title: { type: "string" },
      sourceUrl: { type: ["string", "null"] },
      rawContent: { type: ["string", "null"] },
      location: { type: ["string", "null"] },
      department: { type: ["string", "null"] },
      compensation: { type: ["string", "null"] },
      employmentType: { type: ["string", "null"] },
    },
    required: ["job"],
  },
  parser: z.object({
    job: z.string(),
    company: z.string().nullable().optional(),
    companyName: z.string().nullable().optional(),
    title: z.string().min(1).optional(),
    sourceUrl: z
      .string()
      .transform(normalizeUrlInput)
      .pipe(z.string().url())
      .nullable()
      .optional(),
    rawContent: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    compensation: z.string().nullable().optional(),
    employmentType: z.string().nullable().optional(),
  }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobBySlug(ctx.userId, input.job);
    if (!jobResolved.ok)
      return slugLookupError(jobResolved, { source: "update_job" });

    // Resolve the company slug (when linking to a non-null company) — the rest
    // (collision guard, companyName-clear invariant, field diff, write) is the
    // entity fn's job.
    let linkCompanyId: string | null | undefined = undefined;
    if (input.company !== undefined) {
      if (input.company === null) {
        linkCompanyId = null;
      } else {
        const companyResolved = await resolveCompanyBySlug(
          ctx.userId,
          input.company,
        );
        if (!companyResolved.ok)
          return slugLookupError(companyResolved, { source: "update_job" });
        linkCompanyId = companyResolved.value.id;
      }
    }

    const result = await updateJob({
      jobId: jobResolved.value.id,
      patch: {
        linkCompanyId,
        companyName: input.companyName,
        title: input.title,
        sourceUrl: input.sourceUrl,
        rawContent: input.rawContent,
        location: input.location,
        department: input.department,
        compensation: input.compensation,
        employmentType: input.employmentType,
      },
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return toolError(
          "ENTITY_NOT_FOUND",
          `no job found for "${input.job}".`,
          "update_job:not_found:job",
        );
      }
      return toolError(
        "STATE_CONFLICT",
        `another job already holds this sourceUrl (slug=${result.conflictSlugOrId}).`,
        "update_job:conflict:duplicate_source_url",
      );
    }
    if (result.appliedFields.length === 0) {
      return { content: "no fields to update" };
    }
    return {
      content: `updated ${jobResolved.value.slug ?? jobResolved.value.id} fields: ${result.appliedFields.join(", ")}`,
    };
  },
};
