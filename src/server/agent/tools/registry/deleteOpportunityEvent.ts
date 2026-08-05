import { z } from "zod";

import { statusBackedByOpportunityEvent } from "@/server/entities/opportunities/logOpportunityEvent";
import {
  getOpportunityEventById,
  deleteOpportunityEvent,
} from "@/server/entities/opportunities/opportunityEventEdits";
import { formatEventStamp } from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Delete ONE lead timeline event, targeted by its id (from
// list_opportunity_events). Opportunity counterpart to delete_job_event. Like
// that tool, it does NOT recompute the cached lead status — status can be set
// off-log (update_opportunity) — so when the removed event was the one driving
// the status, the result flags it for Hank to fix explicitly with the user.
export const deleteOpportunityEventTool: ToolDef<{ eventId: string }> = {
  name: "delete_opportunity_event",
  affectsViewedState: true,
  description:
    "Delete ONE lead timeline event you logged — targeted by the event's `id` (from list_opportunity_events) — when it was logged in error and the user wants it gone. Removes only the one event. It does not by itself change the lead's status: if the deleted event was the one that set the current status, the result will tell you, and you should set the correct status explicitly (log_opportunity_events / update_opportunity) after confirming with the user.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description:
          "The id of the event to delete (from list_opportunity_events, shown as `id=…`).",
      },
    },
    required: ["eventId"],
  },
  parser: z.object({ eventId: z.string().min(1) }),
  async handle({ eventId }, ctx) {
    const found = await getOpportunityEventById(ctx.userId, eventId);
    if (found.kind === "not_found") {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no lead event with id "${eventId}" for one of your leads — get a current id from list_opportunity_events.`,
        "delete_opportunity_event:not_found:event",
      );
    }
    const target = found.event;
    await deleteOpportunityEvent(target.id);
    const staleNote = statusBackedByOpportunityEvent(
      found.opportunityStatus,
      target.type,
    )
      ? ` The lead's status is still ${found.opportunityStatus}, which this event set — if that's no longer right, set the correct status explicitly (log_opportunity_events / update_opportunity) after checking with the user.`
      : ` Timeline entry only — the lead's status (${found.opportunityStatus}) is unchanged; deleting an event never moves it.`;
    return {
      content: `deleted ${target.type} lead event (${formatEventStamp(target.occurredAt, ctx.timeZone)}).${staleNote}`,
    };
  },
};
