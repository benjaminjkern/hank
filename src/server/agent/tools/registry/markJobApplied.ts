// The `mark_job_applied` tool — the agent / historical-entry entry point to the
// canonical APPLIED write. Thin wrapper: resolves the job slug and delegates to
// `markJobApplied` in entities/jobs. The drafting widget's submit button is the
// other entry to that same write.

import { z } from "zod";

import { ApplyChannel } from "@/generated/prisma/client";
import { markJobApplied } from "@/server/entities/jobs/markJobApplied";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";
import { parseEventDateTime } from "@/server/platform/time/localTime";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

const ALL_APPLY_CHANNELS = Object.values(ApplyChannel) as [
  ApplyChannel,
  ...ApplyChannel[],
];

export const markJobAppliedTool: ToolDef<{
  job: string;
  occurredAt?: string;
  applyChannel?: ApplyChannel;
  notes?: string;
}> = {
  name: "mark_job_applied",
  affectsViewedState: true,
  description:
    "Record that the user applied to a job. Single canonical APPLIED path — both the drafting widget's submit button and historical entry ('I applied to Coinbase in March') route through here. Logs an APPLIED event, advances JobInteraction → APPLIED, stamps applyChannel (RECRUITER if the job is linked to an opportunity, DIRECT otherwise, unless you pass an explicit channel), and clears the role's shortlist stance. Whatever was drafted stays — the user may reuse it elsewhere. This is an ATOMIC RECORD-ONLY action: it does NOT bring up the next role or move the screen. To move on afterward, call a navigation tool — company_walkthrough on this company (brings up its remaining roles), caught_up_company (done with this company), or show_whats_next (top-level). Use this — not log_job_events — for APPLIED.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The role's slug." },
      occurredAt: {
        type: "string",
        description:
          "ISO datetime when the application was submitted. Defaults to now. Use this for historical entries.",
      },
      applyChannel: {
        type: "string",
        enum: ALL_APPLY_CHANNELS as readonly string[] as string[],
        description:
          "How the application was submitted: RECRUITER (recruiter mediated), REFERRAL (friend pointed at a direct apply), DIRECT (scan / careers page). Omit to take the opportunity-link default.",
      },
      notes: {
        type: "string",
        description:
          "Optional freeform context attached to the APPLIED event (e.g. 'submitted via the recruiter portal').",
      },
    },
    required: ["job"],
  },
  parser: z.object({
    job: z.string(),
    occurredAt: z.string().optional(),
    applyChannel: z.enum(ALL_APPLY_CHANNELS).optional(),
    notes: z.string().optional(),
  }),
  async handle({ job, occurredAt, applyChannel, notes }, ctx) {
    const jobResolved = await resolveJobBySlug(ctx.userId, job);
    if (!jobResolved.ok) return slugLookupError(jobResolved);
    const result = await markJobApplied({
      userId: ctx.userId,
      jobId: jobResolved.value.id,
      occurredAt: parseEventDateTime(occurredAt, ctx.timeZone) ?? undefined,
      applyChannel,
      notes,
    });
    // Record-only tool: nothing advances on its own. Point Hank at the right
    // navigation tool depending on whether roles remain at this company. We do
    // NOT name the next role — the picker shows it; naming one
    // in chat is exactly the "Hank draws the screen" failure.
    const moveOnHint = result.nextJobId
      ? " Recorded only — this does NOT bring up the next role. If the user wants to keep going here, call company_walkthrough on this company to show the remaining roles; if they are done with it, caught_up_company."
      : " Recorded only. No shortlisted roles are left at this company — if the user has worked through it, caught_up_company wraps it; otherwise show_whats_next for what's next.";
    return {
      content: `Logged ${result.jobTitle ?? "this job"} as applied. applyChannel=${result.applyChannel}.${moveOnHint}`,
    };
  },
};
