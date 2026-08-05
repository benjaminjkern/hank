import { z } from "zod";

import type { JobDeferReason } from "@/generated/prisma/client";
import { JOB_DEFER_REASONS } from "@/server/entities/jobs/jobInteractionInputs";
import { deferJob } from "@/server/entities/jobs/setJobAside";

import { resolveJobArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

export const deferJobTool: ToolDef<{
  job?: string;
  reason: JobDeferReason;
  note?: string;
}> = {
  name: "defer_job",
  affectsViewedState: true,
  description:
    "Defer a single role — 'could apply, but other roles rank higher right now.' Use when the user could apply to this but isn't going to any time soon because other jobs make more sense first. It's reversible and holds indefinitely (no revisit timer) until brought back. Reason is OUTRANKED for the usual 'passed over for now', OTHER otherwise. This is an ATOMIC RECORD-ONLY action: it does not bring up the next role — call company_walkthrough on its company afterward to bring up the remaining roles if the user is moving on. **`job` is the role's slug — pass the one the user means.**",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      reason: {
        type: "string",
        enum: JOB_DEFER_REASONS as readonly string[] as string[],
        description:
          "OUTRANKED = could apply, but other roles rank higher right now (the usual case). OTHER = some other 'not now' reason (put it in the note).",
      },
      note: {
        type: "string",
        description:
          "The user's actual reason for holding this role, in their own words where possible — one sentence. Fill this whenever you have it.",
      },
    },
    required: ["reason"],
  },
  parser: z.object({
    job: z.string().optional(),
    reason: z.enum(JOB_DEFER_REASONS),
    note: z.string().optional(),
  }),
  async handle(input, ctx) {
    const resolved = await resolveJobArg(ctx, input.job, {
      source: "defer_job",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!resolved.ok) return resolved.result;
    const jobId = resolved.id;
    await deferJob({
      userId: ctx.userId,
      jobId,
      reason: input.reason,
      note: input.note,
    });
    // Record-only — focus is ephemeral, so nothing advances on its own; the
    // system prompt has Hank call company_walkthrough if the user is moving on.
    return { content: `Job deferred (${input.reason}).` };
  },
};
