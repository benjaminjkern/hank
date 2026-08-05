import { z } from "zod";

import { JobInteractionStatus } from "@/generated/prisma/client";
import { companyJobsQuery } from "@/server/entities/jobs/listCompanyJobs";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";
import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

const ALL_JOB_INTERACTION_STATUSES = Object.values(JobInteractionStatus) as [
  JobInteractionStatus,
  ...JobInteractionStatus[],
];

export const listJobsTool: ToolDef<{
  company: string;
  name?: string;
  status?: JobInteractionStatus[];
  page?: number;
}> = {
  name: "list_jobs",
  description:
    "List the user's roles for a single company, optionally filtered by job title substring and current status. `company` (the company slug) is required — list_jobs is intentionally per-company so output stays compact; for a watchlist-wide view, use list_companies and pick one. Status filter is an array; defaults to EVERY status (CLOSED + DELISTED included) — pass e.g. [\"SHORTLISTED\"] or [\"APPLIED\"] to narrow. Returns each role's slug, title, and status. Results are paginated, 30 per page; pass `page` (1-indexed) for more. Use for 'what's open at Stripe?' / 'what did I shortlist here?' / 'show me the applied ones'.",
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description: "Company slug (e.g. 'stripe').",
      },
      name: {
        type: "string",
        description:
          "Optional case-insensitive substring filter on the job title.",
      },
      status: {
        type: "array",
        items: {
          type: "string",
          enum: ALL_JOB_INTERACTION_STATUSES as readonly string[] as string[],
        },
        description:
          "Optional array of JobInteractionStatus values to NARROW to. Omit to include every status (the default).",
      },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 roles per page, most-recently-updated first. If the footer says more pages exist, pass page:N+1 for the next.",
      },
    },
    required: ["company"],
  },
  parser: z.object({
    company: z.string(),
    name: z.string().optional(),
    status: z.array(z.enum(ALL_JOB_INTERACTION_STATUSES)).optional(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ company: companySlug, name, status, page }, ctx) {
    const companyResolved = await resolveCompanyBySlug(ctx.userId, companySlug);
    if (!companyResolved.ok) {
      return slugLookupError(companyResolved, { source: "list_jobs" });
    }
    const p = await paginate(
      page,
      companyJobsQuery({
        userId: ctx.userId,
        companyId: companyResolved.value.id,
        titleFilter: name,
        statuses: status,
      }),
    );
    const { rows, total } = p;
    if (total === 0) {
      const filterDesc = [
        `company=${companyResolved.value.slug}`,
        name ? `title~"${name}"` : null,
        status && status.length > 0 ? `status in [${status.join(", ")}]` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return { content: `(no jobs match ${filterDesc})` };
    }
    if (isPastLastPage(p)) {
      return { content: pastLastPageMessage(p, "jobs") };
    }
    const lines = rows.map((r) => {
      const statusCol = r.closeReason
        ? `${r.status}:${r.closeReason}`
        : r.status;
      return `${statusCol}\t${r.jobTitle}\t(${r.jobSlug ?? r.jobId})`;
    });
    const header = `${total} job${total === 1 ? "" : "s"} at ${companyResolved.value.name}:`;
    return {
      content: `${header}\n${lines.join("\n")}${pageFooter(p, "jobs")}`,
    };
  },
};
