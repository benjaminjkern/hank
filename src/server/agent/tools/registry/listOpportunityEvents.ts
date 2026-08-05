import { z } from "zod";

import {
  loadOpportunityEventHeader,
  opportunityEventsQuery,
} from "@/server/entities/opportunities/listOpportunityEvents";
import { resolveOpportunityBySlug } from "@/server/entities/resolveBySlug";
import { formatEventStamp } from "@/server/platform/time/localTime";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";
import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// List a lead's (opportunity's) event timeline. Each row carries the event's id,
// which edit_opportunity_event / delete_opportunity_event take to target the
// exact event. The read counterpart to log_opportunity_events. Pure read,
// paginated. Parallel to list_job_events.
export const listOpportunityEventsTool: ToolDef<{
  opportunity: string;
  page?: number;
}> = {
  name: "list_opportunity_events",
  description:
    "List the event timeline for a single lead — every logged event (INBOUND_RECEIVED / CALL_SCHEDULED / CALL_HAPPENED / NEXT_STEP_RECEIVED / CLOSED / NOTE …) with its id, date, and note, newest first, plus the lead's current status. `opportunity` (the lead's slug) is required. Each row includes the event's `id` — pass that id to edit_opportunity_event / delete_opportunity_event to change or remove that exact event. Results are paginated, 30 per page; pass `page` (1-indexed) for more.",
  inputSchema: {
    type: "object",
    properties: {
      opportunity: { type: "string", description: "The lead's slug." },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 events per page, newest first. If the footer says more pages exist, pass page:N+1 for the next.",
      },
    },
    required: ["opportunity"],
  },
  parser: z.object({
    opportunity: z.string(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ opportunity: oppSlug, page }, ctx) {
    const r = await resolveOpportunityBySlug(ctx.userId, oppSlug);
    if (!r.ok) return slugLookupError(r);

    const opportunity = await loadOpportunityEventHeader(
      ctx.userId,
      r.value.id,
    );
    if (!opportunity) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no lead matches "${oppSlug}".`,
        "list_opportunity_events:not_found:opportunity",
      );
    }
    const p = await paginate(
      page,
      opportunityEventsQuery(opportunity.opportunityId),
    );
    const { rows, total } = p;

    const parts: string[] = [
      `# History: ${opportunity.label}`,
      `Current status: ${opportunity.status}`,
    ];
    if (total === 0) {
      parts.push("", "No events logged yet.");
      return { content: parts.join("\n") };
    }
    if (isPastLastPage(p)) {
      return { content: pastLastPageMessage(p, "events") };
    }
    parts.push("", `Events (${total}, newest first):`);
    for (const e of rows) {
      const date = formatEventStamp(e.occurredAt, ctx.timeZone);
      const src = e.source === "USER_LOGGED" ? "user-logged" : "chat";
      const note = e.notes && e.notes.trim() ? ` — ${e.notes.trim()}` : "";
      parts.push(`- ${e.type} · ${date} [${src}]${note} · id=${e.id}`);
    }
    return { content: `${parts.join("\n")}${pageFooter(p, "events")}` };
  },
};
