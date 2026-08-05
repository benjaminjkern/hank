import { z } from "zod";

import {
  getJobEventById,
  deleteJobEvent,
} from "@/server/entities/jobs/jobEventEdits";
import { statusBackedByEvent } from "@/server/entities/jobs/jobEventStatus";
import { formatEventStamp } from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Delete a single already-logged job timeline event, targeted by its id (from
// list_job_events). The narrow, surgical counterpart to untrack_job (which nukes
// the whole JobInteraction + its entire event timeline): this removes ONE event
// when the user says "I never actually interviewed there" / "that applied event
// is wrong, take it off." Deliberately does NOT recompute the cached
// JobInteraction.status — the status can be reason-carrying (CLOSED/DEFERRED) and
// set outside the event log, so a mechanical recompute could land the wrong
// status. Instead, when the removed event was the one currently driving the
// status, the result flags it so Hank can set the status explicitly (with the
// user) via log_job_events / close_job / mark_job_applied.
export const deleteJobEventTool: ToolDef<{ eventId: string }> = {
  name: "delete_job_event",
  affectsViewedState: true,
  description:
    "Delete ONE job timeline event you logged — targeted by the event's `id` (from list_job_events) — when it was logged in error and the user wants it gone (e.g. 'I never interviewed there', 'drop that applied event'). This removes only the one event, NOT the whole role — to forget a role entirely use untrack_job. It does not by itself change the role's status: if the deleted event was the one that set the current status, the result will tell you, and you should set the correct status explicitly (log_job_events / close_job / mark_job_applied) after confirming with the user.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description:
          "The id of the event to delete (from list_job_events, shown as `id=…`).",
      },
    },
    required: ["eventId"],
  },
  parser: z.object({ eventId: z.string().min(1) }),
  async handle({ eventId }, ctx) {
    const found = await getJobEventById(ctx.userId, eventId);
    if (found.kind === "not_found") {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no event with id "${eventId}" for one of your roles — get a current id from list_job_events.`,
        "delete_job_event:not_found:event",
      );
    }
    const target = found.event;
    await deleteJobEvent(target.id);
    // Flag a possibly-stale cached status: if the deleted event's type set the
    // current status, that status is now unbacked. Don't auto-recompute (status
    // can be reason-carrying / set off-log) — tell Hank so he fixes it
    // explicitly with the user. State where the status landed even when it's
    // fine: silence reads as "unreported" rather than "untouched", and Hank will
    // narrate the deletion as if it also reopened the role.
    const staleNote = statusBackedByEvent(
      found.jobInteractionStatus,
      target.type,
    )
      ? ` The role's status is still ${found.jobInteractionStatus}, which this event set — if that's no longer right, set the correct status explicitly (log_job_events / close_job / mark_job_applied) after checking with the user.`
      : ` Timeline entry only — the role's status (${found.jobInteractionStatus}) is unchanged; deleting an event never moves it.`;
    return {
      content: `deleted ${target.type} event (${formatEventStamp(target.occurredAt, ctx.timeZone)}).${staleNote}`,
    };
  },
};
