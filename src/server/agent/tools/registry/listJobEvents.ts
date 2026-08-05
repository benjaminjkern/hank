import { z } from "zod";

import {
  loadJobEventHeader,
  jobEventsQuery,
} from "@/server/entities/jobs/listJobEvents";
import { formatEventStamp } from "@/server/platform/time/localTime";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";
import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// List a role's JobInteraction event timeline (applied / interviewed / skipped /
// notes etc.) WITHOUT loading the full posting content. The read counterpart to
// log_job_events / edit_job_event / delete_job_event — each row carries the
// event's id, which edit_job_event / delete_job_event take to target the exact
// event (no "most recent of type" guessing). Hank reaches for this when the user
// asks "what's the history on this one?" / "when did I apply?" and does NOT want
// the whole job description (that's read_job_description). Pure read, paginated.
export const listJobEventsTool: ToolDef<{ job?: string; page?: number }> = {
  name: "list_job_events",
  description:
    "List the event timeline for a single role — every logged event (SURFACED / SCANNED / SHORTLISTED / APPLIED / interview / OFFERED / REJECTED / WITHDRAWN / CLOSED / NOTE …) with its id, date, and note, newest first, plus the role's current status. `job` (the role's slug) — pass the role the user means. Each row includes the event's `id` — pass that id to edit_job_event / delete_job_event to change or remove that exact event. Results are paginated, 30 per page; pass `page` (1-indexed) for more. Cheaper than read_job_description (no full posting text) and side-effect-free (no SCANNED promotion). Use whenever the user asks about a role's history, or when you need an event id to edit/delete an event.",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 events per page, newest first. If the footer says more pages exist, pass page:N+1 for the next.",
      },
    },
    required: [],
  },
  parser: z.object({
    job: z.string().optional(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ job: jobSlug, page }, ctx) {
    const jobResolved = await resolveJobArg(ctx, jobSlug, {
      source: "list_job_events",
      ambiguousMessage:
        "no job slug passed — pass the slug of the role whose history you want.",
    });
    if (!jobResolved.ok) return jobResolved.result;

    const jobInteraction = await loadJobEventHeader(ctx.userId, jobResolved.id);
    if (!jobInteraction) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no tracked interaction for that job — nothing has been logged for it yet.`,
        "list_job_events:not_found:job_interaction",
      );
    }
    const p = await paginate(
      page,
      jobEventsQuery(jobInteraction.jobInteractionId),
    );
    const { rows, total } = p;

    const parts: string[] = [
      `# History: ${jobInteraction.title} @ ${jobInteraction.companyName}`,
    ];
    const statusLine: string[] = [`Current status: ${jobInteraction.status}`];
    if (jobInteraction.status === "CLOSED" && jobInteraction.closeReason)
      statusLine.push(
        `(${jobInteraction.closeReason}${jobInteraction.closeNote ? `: ${jobInteraction.closeNote}` : ""})`,
      );
    if (jobInteraction.status === "DEFERRED" && jobInteraction.deferReason)
      statusLine.push(
        `(${jobInteraction.deferReason}${jobInteraction.deferNote ? `: ${jobInteraction.deferNote}` : ""})`,
      );
    parts.push(statusLine.join(" "));

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
