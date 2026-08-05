import { z } from "zod";

import {
  getCompanyEventById,
  editCompanyEvent,
} from "@/server/entities/companies/companyEventEdits";
import {
  parseEventDateTime,
  formatEventStamp,
} from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Edit a company feed event — its date and/or notes — targeted by the event's id
// (from list_company_events). Company counterpart to edit_job_event. Narrow +
// single-row: touches only CompanyEvent.occurredAt / CompanyEvent.notes, no
// status recompute (company events don't back a cached status), no cascade.
export const editCompanyEventTool: ToolDef<{
  eventId: string;
  occurredAt?: string;
  notes?: string;
}> = {
  name: "edit_company_event",
  affectsViewedState: true,
  description:
    "Edit a company feed event you already logged — its DATE and/or its NOTES — targeted by the event's `id` (get it from list_company_events). Pass `occurredAt` (ISO date) to fix the date, and/or `notes` to fix the freeform note (empty string clears it). At least one of the two is required. Does NOT change the event's type — to change what KIND of event it is, delete it and log a fresh one. **This edits the feed row and nothing else — it does NOT touch the company's status.** To correct the company's stored status or reason, use update_company_interaction.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description:
          "The id of the event to edit (from list_company_events, shown as `id=…`).",
      },
      occurredAt: {
        type: "string",
        description:
          "The corrected date/time, ISO 8601 in the user's local time. Use the # Today block so the year is right. Omit to leave the date unchanged.",
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
          "edit_company_event:invalid:bad_date",
        );
      }
      when = parsed;
    }
    const target = await getCompanyEventById(ctx.userId, eventId);
    if (!target) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no company event with id "${eventId}" for one of your companies — get a current id from list_company_events.`,
        "edit_company_event:not_found:event",
      );
    }
    const data: { occurredAt?: Date; notes?: string } = {};
    if (when !== undefined) data.occurredAt = when;
    if (notes !== undefined) data.notes = notes;
    await editCompanyEvent(target.id, data);
    const changed: string[] = [];
    if (when !== undefined)
      changed.push(`date → ${formatEventStamp(when, ctx.timeZone)}`);
    if (notes !== undefined)
      changed.push(notes.trim() ? "notes updated" : "notes cleared");
    return {
      content: `edited ${target.type} company event (${changed.join(", ")}). Feed row only — the company's status is unchanged.`,
    };
  },
};
