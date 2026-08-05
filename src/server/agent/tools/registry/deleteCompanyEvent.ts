import { z } from "zod";

import {
  getCompanyEventById,
  deleteCompanyEvent,
} from "@/server/entities/companies/companyEventEdits";
import { formatEventStamp } from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Delete ONE company feed event, targeted by its id (from list_company_events).
// Company counterpart to delete_job_event. Removes only the one feed row — no
// status recompute (company events don't back a cached status) and no cascade to
// any paired JobEvent (a milestone's JobEvent lives on its own timeline; edit
// that separately via delete_job_event if the user wants both gone).
export const deleteCompanyEventTool: ToolDef<{ eventId: string }> = {
  name: "delete_company_event",
  affectsViewedState: true,
  description:
    "Delete ONE company feed event you logged — targeted by the event's `id` (from list_company_events) — when it was logged in error and the user wants it off the company's activity feed. Removes only that one row. **It does NOT touch the company's status** — a company's status is never driven by its feed, so removing a CLOSED/PAUSED feed row does not reopen them; to correct the stored status use update_company_interaction. It also does not touch any paired role event: if a milestone (e.g. APPLIED) also has a JobEvent on the role's timeline and the user wants that gone too, remove it with delete_job_event.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description:
          "The id of the event to delete (from list_company_events, shown as `id=…`).",
      },
    },
    required: ["eventId"],
  },
  parser: z.object({ eventId: z.string().min(1) }),
  async handle({ eventId }, ctx) {
    const target = await getCompanyEventById(ctx.userId, eventId);
    if (!target) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no company event with id "${eventId}" for one of your companies — get a current id from list_company_events.`,
        "delete_company_event:not_found:event",
      );
    }
    await deleteCompanyEvent(target.id);
    return {
      content: `deleted ${target.type} company event (${formatEventStamp(target.occurredAt, ctx.timeZone)}). Feed row only — the company's status is unchanged (removing a CLOSED/PAUSED feed row does not reopen them; use update_company_interaction for that).`,
    };
  },
};
