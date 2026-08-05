import { z } from "zod";

import { untrackJob } from "@/server/entities/jobs/untrackJob";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const untrackJobTool: ToolDef<{ job?: string }> = {
  name: "untrack_job",
  // The role vanishes from the user's view. Focus is ephemeral, so there's no
  // slot to clear — the client refetch this flag triggers re-derives the panel,
  // and the deleted interaction just doesn't load.
  affectsViewedState: true,
  description:
    'Hard-delete this user\'s tracking of a role — removes the interaction and its whole event history. The underlying posting stays on file, so if it gets scraped again it comes back as a fresh new role. Use for true cleanup when the user wants it gone entirely ("forget about this one", "I added this by mistake", "that was junk from the scraper"). For a normal "not applying to this one" — which keeps the history — use close_job instead; that\'s the right tool almost every time. `job` is the role\'s slug — pass the role the user means; don\'t ask "which one" when "this" is clear.',
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
    },
    required: [],
  },
  parser: z.object({ job: z.string().optional() }),
  async handle({ job }, ctx) {
    const resolved = await resolveJobArg(ctx, job, {
      source: "untrack_job",
      ambiguousMessage:
        "no job slug passed — pass the slug of the role to untrack.",
    });
    if (!resolved.ok) return resolved.result;
    const removed = await untrackJob({
      userId: ctx.userId,
      jobId: resolved.id,
    });
    if (!removed) {
      return toolError(
        "ENTITY_NOT_FOUND",
        "no tracked interaction to untrack for that role — either the slug is wrong or the user never had an interaction with it. Use list_jobs to find the right slug.",
        "untrack_job:not_found:job_interaction",
      );
    }
    return {
      content: `Untracked "${removed.title}" — removed it and its history. It'll come back as new if the posting is scraped again.`,
    };
  },
};
