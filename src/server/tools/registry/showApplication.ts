import { z } from "zod";

import { sayUiEvents, statusEvent } from "@/server/contracts";
import { buildApplicationEvents } from "@/server/panels/showEvents";
import { toolError } from "@/server/platform/agent/toolError";

import { resolveJobArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

// show_application — put a job's application page on the user's screen. The
// show_* sibling for the application: display only, starts no work, writes
// nothing. Use it to point at a draft, not to make one.
export const showApplicationTool: ToolDef<{ job?: string }> = {
  name: "show_application",
  affectsViewedState: false,
  description:
    "Put a role's application page on the user's screen (right panel) — every question the form asks, with what's written for each and what's still blank. Use it when the user wants to see, read, or work on their application, or to point them at a draft you've just made. Pure display: starts no drafting, changes nothing. To actually write an answer use draft_application_question; to draft the whole thing use draft_application. `job` (the role's slug) — pass the role the user means.",
  parser: z.object({
    job: z
      .string()
      .optional()
      .describe("The role's slug — the role the user means."),
  }),
  async handle({ job: jobSlug }, ctx) {
    const jobResolved = await resolveJobArg(ctx, jobSlug, {
      source: "show_application",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;

    const { events, application } = await buildApplicationEvents(
      ctx.userId,
      jobResolved.id,
    );
    if (!application) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no application record found for that role yet.`,
        "show_application:not_found:job_interaction",
      );
    }

    const written = application.items.filter((i) => i.text?.trim()).length;
    const blank = application.items.length - written;
    await sayUiEvents(ctx.say, events);
    await ctx.say(
      statusEvent(
        `Pulled up the ${application.jobTitle} application at ${application.companyName}.`,
      ),
    );
    return {
      content: `Put the ${application.jobTitle} application on the user's screen — ${written} item${written === 1 ? "" : "s"} written, ${blank} still blank.`,
    };
  },
};
