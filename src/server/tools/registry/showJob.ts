import { z } from "zod";

import { sayUiEvents, statusEvent } from "@/server/contracts";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";
import { buildShowEvents } from "@/server/panels/showEvents";
import { toolError } from "@/server/platform/agent/toolError";
import { formatFocusRefToken } from "@/shared/focusRefToken";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// show_job — put a role's page on the user's screen + drop a clickable chip.
// PURE DISPLAY (see show_company). The presentational counterpart to
// work_on_job: show_job just displays the posting; work_on_job starts the
// application workflow. Non-handoff; chip is view-only.
export const showJobTool: ToolDef<{ job: string }> = {
  name: "show_job",
  affectsViewedState: false,
  description:
    "Put a role's page on the user's screen (right panel) and drop a clickable chip in the chat — a pure display action that starts no work and changes nothing. Use it when you're referring to a role and want the user to see it. NOT for starting an application — that's work_on_job. `job` is the role's slug.",
  parser: z.object({ job: z.string().describe("The role's slug.") }),
  async handle(input, ctx) {
    const r = await resolveJobBySlug(ctx.userId, input.job);
    if (!r.ok) return slugLookupError(r);
    const show = await buildShowEvents(ctx.userId, { jobId: r.value.id });
    if (!show.job) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `couldn't load the page for "${input.job}"`,
        "show_job:not_found:job",
      );
    }
    await sayUiEvents(ctx.say, show.events);
    await ctx.say(
      statusEvent(
        `Pulled up ${formatFocusRefToken("job", r.value.id, show.job.title)}.`,
      ),
    );
    return {
      content: `Put ${r.value.slug}'s page on the user's screen. Nothing else happens — this is display only.`,
    };
  },
};
