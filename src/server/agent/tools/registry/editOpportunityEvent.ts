import { z } from "zod";

import {
  getOpportunityEventById,
  editOpportunityEvent,
} from "@/server/entities/opportunities/opportunityEventEdits";
import {
  parseEventDateTime,
  formatEventStamp,
} from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Edit a lead timeline event — its date and/or notes — targeted by the event's
// id (from list_opportunity_events). Opportunity counterpart to edit_job_event.
// Narrow + single-row: touches only OpportunityEvent.occurredAt / .notes, no
// status recompute (the cached status depends on the event's TYPE, unchanged
// here), no cascade.
export const editOpportunityEventTool: ToolDef<{
  eventId: string;
  occurredAt?: string;
  notes?: string;
}> = {
  name: "edit_opportunity_event",
  affectsViewedState: true,
  description:
    "Edit a lead event you already logged — its DATE and/or its NOTES — targeted by the event's `id` (get it from list_opportunity_events). Pass `occurredAt` (ISO date) to fix the date, and/or `notes` to fix the freeform note (empty string clears it). At least one of the two is required. Does NOT change the event's type or the lead's status — to change what KIND of event it is, delete it and log a fresh one.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description:
          "The id of the event to edit (from list_opportunity_events, shown as `id=…`).",
      },
      occurredAt: {
        type: "string",
        description:
          "The corrected date/time, ISO 8601 in the user's local time. Include the clock time for a scheduled call. Use the # Today block so the year is right. Omit to leave the date unchanged.",
      },
      notes: {
        type: "string",
        description:
          "The corrected freeform note. Pass an empty string to clear it. Omit to leave it unchanged.",
      },
    },
    required: ["eventId"],
  },
  parser: z
    .object({
      eventId: z.string().min(1),
      occurredAt: z.string().optional(),
      notes: z.string().optional(),
    })
    .refine((v) => v.occurredAt !== undefined || v.notes !== undefined, {
      message: "provide occurredAt and/or notes to change",
    }),
  async handle({ eventId, occurredAt, notes }, ctx) {
    let when: Date | undefined;
    if (occurredAt !== undefined) {
      const parsed = parseEventDateTime(occurredAt, ctx.timeZone);
      if (!parsed) {
        return toolError(
          "INVALID_INPUT",
          `occurredAt is not a valid ISO date: ${occurredAt}`,
          "edit_opportunity_event:invalid:bad_date",
        );
      }
      when = parsed;
    }
    const found = await getOpportunityEventById(ctx.userId, eventId);
    if (found.kind === "not_found") {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no lead event with id "${eventId}" for one of your leads — get a current id from list_opportunity_events.`,
        "edit_opportunity_event:not_found:event",
      );
    }
    const data: { occurredAt?: Date; notes?: string } = {};
    if (when !== undefined) data.occurredAt = when;
    if (notes !== undefined) data.notes = notes;
    await editOpportunityEvent(found.event.id, data);
    const changed: string[] = [];
    if (when !== undefined)
      changed.push(`date → ${formatEventStamp(when, ctx.timeZone)}`);
    if (notes !== undefined)
      changed.push(notes.trim() ? "notes updated" : "notes cleared");
    return {
      content: `edited ${found.event.type} lead event (${changed.join(", ")}). Timeline entry only — the lead's status is unchanged (this tool can't change an event's type, so it can't move the status).`,
    };
  },
};
