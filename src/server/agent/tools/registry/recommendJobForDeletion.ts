import { z } from "zod";

import { recommendJobForDeletion } from "@/server/entities/jobs/recommendJobForDeletion";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const recommendJobForDeletionTool: ToolDef<{
  job?: string;
  reason: string;
}> = {
  name: "recommend_job_for_deletion",
  // A flag on a global row — the posting keeps rendering normally for everyone
  // until an admin reviews it, so nothing the user is looking at changes.
  affectsViewedState: false,
  description:
    "Flag a posting for an admin to hard-delete. Sets a deletion recommendation + reason; the posting stays in place and renders normally until an admin reviews it and either approves the delete or clears the flag. This never deletes data itself, and it flags the GLOBAL posting for everyone — so reach for the softer options first: close_job keeps the history; untrack_job removes only this user's copy. Only flag when the posting itself is junk (scraper hallucination like a 'View open roles' link, a duplicate row, a listing that never really existed). Re-calling with a new reason updates the recommendation. `job` is the role's slug — pass the posting the user means.",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the posting the user means.",
      },
      reason: {
        type: "string",
        description:
          "One-sentence justification (e.g. 'scraper hallucination — the URL is the Ashby board root, not a posting'). Shown to the admin reviewing the flag.",
      },
    },
    required: ["reason"],
  },
  parser: z.object({ job: z.string().optional(), reason: z.string().min(1) }),
  async handle({ job, reason }, ctx) {
    const resolved = await resolveJobArg(ctx, job, {
      source: "recommend_job_for_deletion",
      ambiguousMessage:
        "no job slug passed — pass the slug of the posting to flag.",
    });
    if (!resolved.ok) return resolved.result;
    const flagged = await recommendJobForDeletion({
      jobId: resolved.id,
      reason,
    });
    if (!flagged) {
      return toolError(
        "ENTITY_NOT_FOUND",
        "no posting found to flag for that slug.",
        "recommend_job_for_deletion:not_found:job",
      );
    }
    const prefix = flagged.wasAlreadyFlagged
      ? "Updated the deletion recommendation for"
      : "Flagged for deletion:";
    return {
      content: `${prefix} "${flagged.title}" @ ${flagged.companyLabel}. Reason: ${reason}. An admin will review it — nothing's deleted yet.`,
    };
  },
};
