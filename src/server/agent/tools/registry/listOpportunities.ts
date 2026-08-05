import { z } from "zod";

import { OpportunityStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { ALL_LEAD_STATUSES } from "@/server/entities/opportunities/leadInputs";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";

import type { ToolDef } from "../lib/types";

export const listOpportunitiesTool: ToolDef<{
  status?: OpportunityStatus;
  page?: number;
}> = {
  name: "list_opportunities",
  description:
    "List the user's opportunities (leads), sorted by nextStepAt (soonest first). Each lead's pitched roles (= linked JobInteractions) are summarized inline. Pass status to filter; default omits CLOSED. Results are paginated, 30 leads per page; pass `page` (1-indexed) for more. Use to remind yourself what's pending before kicking off work, or when the user asks 'what's on the inbound side'.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ALL_LEAD_STATUSES as readonly string[] as string[],
        description:
          "Filter to a single status. Omit to list active leads (OPEN + SCREENING + AWAITING).",
      },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 leads per page, ordered soonest-next-step first. If the footer says more pages exist, pass page:N+1 for the next.",
      },
    },
  },
  parser: z.object({
    status: z.enum(ALL_LEAD_STATUSES).optional(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ status, page }, ctx) {
    const where = status
      ? { userId: ctx.userId, status }
      : {
          userId: ctx.userId,
          status: {
            in: [
              OpportunityStatus.OPEN,
              OpportunityStatus.SCREENING,
              OpportunityStatus.AWAITING,
            ],
          },
        };
    const p = await paginate(page, {
      count: () => prisma.opportunity.count({ where }),
      rows: ({ skip, take }) =>
        prisma.opportunity.findMany({
          where,
          // Stable order so paging forward doesn't skip/repeat rows on ties:
          // soonest next-step first, tiebroken by updatedAt then id.
          orderBy: [
            { nextStepAt: { sort: "asc", nulls: "last" } },
            { updatedAt: "desc" },
            { id: "asc" },
          ],
          skip,
          take,
          select: {
            id: true,
            slug: true,
            label: true,
            status: true,
            nextStepAt: true,
            primaryContact: { select: { name: true, agency: true } },
            jobInteractions: {
              select: {
                id: true,
                status: true,
                job: {
                  select: {
                    id: true,
                    slug: true,
                    title: true,
                    companyName: true,
                    company: { select: { name: true } },
                  },
                },
              },
            },
          },
        }),
    });
    if (p.total === 0) return { content: "(no opportunities)" };
    if (isPastLastPage(p)) {
      return { content: pastLastPageMessage(p, "opportunities") };
    }
    const { rows } = p;
    const lines: string[] = [];
    for (const o of rows) {
      const next = o.nextStepAt ? ` · next ${o.nextStepAt.toISOString()}` : "";
      const pc = o.primaryContact
        ? ` · via ${o.primaryContact.name}${o.primaryContact.agency ? ` (${o.primaryContact.agency})` : ""}`
        : "";
      lines.push(`${o.status}\t${o.slug ?? o.id}\t${o.label}${pc}${next}`);
      for (const ji of o.jobInteractions) {
        const co = ji.job.company?.name ?? ji.job.companyName ?? "(no company)";
        lines.push(
          `  ${ji.status}\t${ji.job.slug ?? ji.id}\t${ji.job.title} @ ${co}`,
        );
      }
    }
    return { content: lines.join("\n") + pageFooter(p, "opportunities") };
  },
};
