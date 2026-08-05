import { z } from "zod";

import { companyEventsQuery } from "@/server/entities/companies/listCompanyEvents";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { formatEventStamp } from "@/server/platform/time/localTime";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";
import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// List a company's activity feed (the same CompanyEvent timeline the company
// page's "Recent activity" card renders). Each row carries the event's id, which
// edit_company_event / delete_company_event take to target the exact event. The
// read counterpart to log_company_events. Pure read, paginated.
export const listCompanyEventsTool: ToolDef<{
  company: string;
  page?: number;
}> = {
  name: "list_company_events",
  description:
    "List a company's activity feed — every event on its 'Recent activity' timeline (SCRAPE_FOUND / JOBS_CLOSED / SHORTLIST_RAN / APPLIED / INTERVIEW_* / PAUSED / CLOSED / …) with its id, date, and note, newest first. `company` (the company slug) is required. Each row includes the event's `id` — pass that id to edit_company_event / delete_company_event to change or remove that exact event. Results are paginated, 30 per page; pass `page` (1-indexed) for more. Use for 'what's happened with Stripe?' / 'show the activity on this company', or to get an event id to edit/delete.",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "Company slug (e.g. 'stripe')." },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 events per page, newest first. If the footer says more pages exist, pass page:N+1 for the next.",
      },
    },
    required: ["company"],
  },
  parser: z.object({
    company: z.string(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ company: companySlug, page }, ctx) {
    const companyResolved = await resolveCompanyBySlug(ctx.userId, companySlug);
    if (!companyResolved.ok) {
      return slugLookupError(companyResolved, {
        source: "list_company_events",
      });
    }
    const p = await paginate(
      page,
      companyEventsQuery(ctx.userId, companyResolved.value.id),
    );
    const { rows, total } = p;
    if (total === 0) {
      return {
        content: `(no activity logged for ${companyResolved.value.name} yet)`,
      };
    }
    if (isPastLastPage(p)) {
      return { content: pastLastPageMessage(p, "events") };
    }
    const header = `Activity for ${companyResolved.value.name} (${total}, newest first):`;
    const lines = rows.map((e) => {
      const date = formatEventStamp(e.occurredAt, ctx.timeZone);
      const role = e.jobTitle ? ` · ${e.jobTitle}` : "";
      const note = e.notes && e.notes.trim() ? ` — ${e.notes.trim()}` : "";
      return `- ${e.type} · ${date}${role}${note} · id=${e.id}`;
    });
    return {
      content: `${header}\n${lines.join("\n")}${pageFooter(p, "events")}`,
    };
  },
};
