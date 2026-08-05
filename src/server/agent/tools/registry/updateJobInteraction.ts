import { z } from "zod";

import {
  type JobCloseReason,
  JobInteractionStatus,
  type JobDeferReason,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  ALL_JOB_CLOSE_REASONS,
  JOB_DEFER_REASONS,
  SETTABLE_JOB_STATUSES,
} from "@/server/entities/jobs/jobInteractionInputs";
import { updateJobInteraction } from "@/server/entities/jobs/updateJobInteraction";
import {
  resolveJobBySlug,
  resolveOpportunityBySlug,
} from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const updateJobInteractionTool: ToolDef<{
  job: string;
  status?: JobInteractionStatus;
  closeReason?: JobCloseReason;
  closeNote?: string;
  deferReason?: JobDeferReason;
  deferNote?: string;
  opportunity?: string | null;
}> = {
  name: "update_job_interaction",
  affectsViewedState: true,
  description:
    "**REPAIR TOOL — NOT the normal way to change a role's status. It writes the row and logs NOTHING to the timeline, so the role's history will have no record of the change.** Reach for it ONLY when the stored record is simply WRONG and you're fixing a bookkeeping error: the user says a role you have as passed is actually just on hold, or as closed is actually still live, or the reason on it is off. **If the thing is happening NOW — the user is passing, holding, applying, or telling you an employer moved — that is the standard flow and MUST go through the event tools so the history has it: mark_job_applied (applied), close_job (passing now), defer_job (holding now), log_job_events (rejected / interview / response / note).** Ask yourself which it is before calling: 'the record is wrong' → here; 'this just happened' → an event tool. What it corrects: status, the structured why behind a pass (`closeReason` + `closeNote`) or a hold (`deferReason` + `deferNote`), and whether it hangs off an inbound lead (`opportunity` = the lead's slug to attach, null to detach). If the correction should ALSO leave a trace on the role's timeline, log a NOTE event with log_job_events — NOTE records without moving the status, so it won't undo the fix you just made. Cover letters and short answers are NOT here — those are save_application_answer (the user's own words) and draft_application_question / draft_application (Hank-written). This is for JOBS — never pass a company slug to it; for a company use the company tools.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The role's slug." },
      status: {
        type: "string",
        enum: SETTABLE_JOB_STATUSES as readonly string[] as string[],
        description:
          "Set the role's status directly. Setting CLOSED requires closeReason; setting DEFERRED requires deferReason. Any other status clears both reason pairs (a revived role keeps no stale 'why').",
      },
      closeReason: {
        type: "string",
        enum: ALL_JOB_CLOSE_REASONS,
        description:
          "Structured reason this role is passed on. WITHDRAWN = applied then pulled the application; NOT_A_MATCH = doesn't fit the search thesis; OTHER = none of the above. Only valid alongside status CLOSED, or on its own to fix the reason on an already-closed role.",
      },
      closeNote: {
        type: "string",
        description:
          "Freeform explanation for the pass — the specific 'why' beyond the bucket, in the user's own words where possible.",
      },
      deferReason: {
        type: "string",
        enum: JOB_DEFER_REASONS as readonly string[] as string[],
        description:
          "Structured reason this role is on hold. OUTRANKED = could apply, but other roles rank higher right now (the usual case); OTHER = some other 'not now'. Only valid alongside status DEFERRED, or on its own to fix the reason on an already-deferred role.",
      },
      deferNote: {
        type: "string",
        description:
          "Freeform explanation for the hold, in the user's own words where possible — one sentence.",
      },
      opportunity: {
        type: ["string", "null"],
        description:
          "Attach (lead slug) or detach (null) the role to/from an inbound Opportunity. Use at intake when a recruiter pitches a role whose `sourceUrl` already matches a role we track — reuse the existing record and set this field to wire it into the lead.",
      },
    },
    required: ["job"],
  },
  parser: z.object({
    job: z.string(),
    status: z.enum(SETTABLE_JOB_STATUSES).optional(),
    closeReason: z.enum(ALL_JOB_CLOSE_REASONS).optional(),
    closeNote: z.string().optional(),
    deferReason: z.enum(JOB_DEFER_REASONS).optional(),
    deferNote: z.string().optional(),
    opportunity: z.string().nullable().optional(),
  }),
  async handle(
    {
      job: jobSlug,
      status,
      closeReason,
      closeNote,
      deferReason,
      deferNote,
      opportunity,
    },
    ctx,
  ) {
    // Symmetric reason rejection, same shape as the company statuses: a reason
    // paired with a status that doesn't carry it signals the agent is confused
    // about which lever it's pulling, and silently stripping it would hide that.
    // Only checked when a status is passed — a bare closeNote is the legitimate
    // "fix the why on a row that's already closed" case.
    if (status !== undefined) {
      if (
        status !== JobInteractionStatus.CLOSED &&
        (closeReason || closeNote)
      ) {
        return toolError(
          "STATE_CONFLICT",
          `closeReason/closeNote only apply to status CLOSED — you passed status ${status}. To pass on this role use status CLOSED with a closeReason, or drop the close fields.`,
          "update_job_interaction:reason_status_mismatch:close",
        );
      }
      if (
        status !== JobInteractionStatus.DEFERRED &&
        (deferReason || deferNote)
      ) {
        return toolError(
          "STATE_CONFLICT",
          `deferReason/deferNote only apply to status DEFERRED — you passed status ${status}. To hold this role use status DEFERRED with a deferReason, or drop the defer fields.`,
          "update_job_interaction:reason_status_mismatch:defer",
        );
      }
      if (status === JobInteractionStatus.CLOSED && !closeReason) {
        return toolError(
          "INVALID_INPUT",
          `status CLOSED needs a closeReason (one of ${ALL_JOB_CLOSE_REASONS.join(", ")}) so the reason the role was passed on is recorded.`,
          "update_job_interaction:missing_reason:close",
        );
      }
      if (status === JobInteractionStatus.DEFERRED && !deferReason) {
        return toolError(
          "INVALID_INPUT",
          `status DEFERRED needs a deferReason (one of ${JOB_DEFER_REASONS.join(", ")}) so the reason the role is on hold is recorded.`,
          "update_job_interaction:missing_reason:defer",
        );
      }
    }
    // Resolve (and validate ownership of) the opportunity slug before
    // attaching — don't let an agent attach a JobInteraction to someone else's
    // lead. `opportunity === null` means detach; undefined means leave as-is.
    let opportunityId: string | null | undefined = undefined;
    if (opportunity !== undefined) {
      if (opportunity === null) {
        opportunityId = null;
      } else {
        const opportunityResolved = await resolveOpportunityBySlug(
          ctx.userId,
          opportunity,
        );
        if (!opportunityResolved.ok) {
          return slugLookupError(opportunityResolved);
        }
        opportunityId = opportunityResolved.value.id;
      }
    }
    // Guard against the wrong-entity confusion: the agent sometimes passes a
    // COMPANY slug here to "update a company". Resolve the job slug first and
    // point at the company twin otherwise.
    const jobResolved = await resolveJobBySlug(ctx.userId, jobSlug);
    if (!jobResolved.ok) {
      // Might be a company slug/id the agent mistakenly passed.
      const company = await prisma.company.findFirst({
        where: { OR: [{ slug: jobSlug }, { id: jobSlug }] },
        select: { name: true },
      });
      if (company) {
        return toolError(
          "ENTITY_NOT_FOUND",
          `"${jobSlug}" is a COMPANY ("${company.name}"), not a job. To CORRECT a company's stored status or its close/pause/block reason, use update_company_interaction. When something actually happens, use close_company / pause_company / caught_up_company / block_company. Re-running close_company on an already-closed company just updates its reason; you do NOT need to revive it first.`,
          "update_job_interaction:wrong_entity:company_id",
        );
      }
      return slugLookupError(jobResolved, { source: "update_job_interaction" });
    }
    const jobId = jobResolved.value.id;
    const applied = await updateJobInteraction(ctx.userId, jobId, {
      status,
      closeReason,
      closeNote,
      deferReason,
      deferNote,
      opportunityId,
    });
    if (applied.length === 0) {
      return { content: "no fields to update" };
    }
    // Restate the no-event contract on every call. The description is long and
    // gets skimmed; the result string is fresh in context right where Hank
    // decides what to tell the user, which is what stops him answering "I
    // recorded that" after a silent correction.
    return {
      content: `updated ${jobResolved.value.slug ?? jobId} fields: ${applied.join(", ")}. Record corrected only — NOTHING was added to this role's timeline. If this was something that just happened rather than a wrong record, log it properly instead: mark_job_applied / close_job / defer_job / log_job_events.`,
    };
  },
};
