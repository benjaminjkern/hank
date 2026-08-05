import { z } from "zod";

import type { JobCloseReason } from "@/generated/prisma/client";
import { JOB_CLOSE_REASONS } from "@/server/entities/jobs/jobInteractionInputs";
import { closeJob } from "@/server/entities/jobs/setJobAside";

import { resolveJobArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

export const closeJobTool: ToolDef<{
  job?: string;
  reason: JobCloseReason;
  note?: string;
}> = {
  name: "close_job",
  affectsViewedState: true,
  description:
    "Pass on a single shortlisted job. Logs a CLOSED event with the structured reason. Use when the user has decided not to apply to one job within an otherwise-active company. This is an ATOMIC RECORD-ONLY action: it does not bring up the next role — call company_walkthrough on its company afterward to bring up the remaining roles if the user is moving on. **`job` is the role's slug — pass the role the user means; don't ask 'which one' when 'this' is clear.**",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      reason: {
        type: "string",
        enum: JOB_CLOSE_REASONS as readonly string[] as string[],
      },
      note: {
        type: "string",
        description:
          "The user's actual reason for passing, in their own words where possible — one sentence. Fill this whenever you have it (ask a short 'why?' first if they didn't say and it isn't clear from context).",
      },
    },
    required: ["reason"],
  },
  parser: z.object({
    job: z.string().optional(),
    reason: z.enum(JOB_CLOSE_REASONS),
    note: z.string().optional(),
  }),
  async handle(input, ctx) {
    const resolved = await resolveJobArg(ctx, input.job, {
      source: "close_job",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!resolved.ok) return resolved.result;
    const jobId = resolved.id;
    await closeJob({
      userId: ctx.userId,
      jobId,
      reason: input.reason,
      note: input.note,
    });
    // Record-only — focus is ephemeral, so nothing advances on its own; the
    // system prompt has Hank call company_walkthrough if the user is moving on.
    return { content: `Job skipped (${input.reason}).` };
  },
};
