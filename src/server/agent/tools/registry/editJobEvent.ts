import { z } from "zod";

import {
  getJobEventById,
  editJobEvent,
} from "@/server/entities/jobs/jobEventEdits";
import {
  parseEventDateTime,
  formatEventStamp,
} from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Edit an already-logged job timeline event — its date and/or its notes,
// targeted by the event's id (from list_job_events). The common case is a
// mis-dated event (classically a wrong YEAR) or an incomplete note.
// Narrow + single-row: touches only JobEvent.occurredAt /
// JobEvent.notes, no status recompute (the cached status depends on the event's
// TYPE, which this tool never changes — to change an event's type, delete it and
// log a fresh one), no cascade.
export const editJobEventTool: ToolDef<{
  eventId: string;
  occurredAt?: string;
  notes?: string;
}> = {
  name: "edit_job_event",
  affectsViewedState: true,
  description:
    "Edit a job event you already logged — its DATE and/or its NOTES — targeted by the event's `id` (get it from list_job_events). Pass `occurredAt` (ISO date) to fix the date (e.g. you logged an interview with the wrong year and the user corrected you), and/or `notes` to fix the freeform note (pass an empty string to clear it). At least one of the two is required. Use `occurredAt` with the # Today block so the year is right. This tool does NOT change an event's type or the job's status — to change what KIND of event it is, use delete_job_event then log_job_events. This is the edit path — never tell the user a logged event 'can't be changed'.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description:
          "The id of the event to edit (from list_job_events, shown as `id=…`).",
      },
      occurredAt: {
        type: "string",
        description:
          "The corrected date/time, ISO 8601 in the user's local time. Include the clock time for a timed event (e.g. '2026-06-14T14:00' for a 2pm interview); a bare date ('2026-06-14') is fine for untimed events. Use the # Today block so the year/time are right. Omit to leave the date unchanged.",
      },
      notes: {
        type: "string",
        description:
          "The corrected freeform note for this event. Pass an empty string to clear the note. Omit to leave the note unchanged.",
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
          "edit_job_event:invalid:bad_date",
        );
      }
      when = parsed;
    }
    const found = await getJobEventById(ctx.userId, eventId);
    if (found.kind === "not_found") {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no event with id "${eventId}" for one of your roles — get a current id from list_job_events.`,
        "edit_job_event:not_found:event",
      );
    }
    const data: { occurredAt?: Date; notes?: string } = {};
    if (when !== undefined) data.occurredAt = when;
    if (notes !== undefined) data.notes = notes;
    await editJobEvent(found.event.id, data);
    const changed: string[] = [];
    if (when !== undefined)
      changed.push(`date → ${formatEventStamp(when, ctx.timeZone)}`);
    if (notes !== undefined)
      changed.push(notes.trim() ? "notes updated" : "notes cleared");
    return {
      content: `edited ${found.event.type} event (${changed.join(", ")}). Timeline entry only — the role's status is unchanged (this tool can't change an event's type, so it can't move the status).`,
    };
  },
};
