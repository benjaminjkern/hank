import { z } from "zod";

import { formatFocusRefToken } from "@/lib/focusRefToken";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";
import { buildShowEvents } from "@/server/views/showEvents";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

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
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The role's slug." },
    },
    required: ["job"],
  },
  parser: z.object({ job: z.string() }),
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
    return {
      content: `Put ${r.value.slug}'s page on the user's screen. Nothing else happens — this is display only.`,
      events: show.events,
      statusLines: [
        `Pulled up ${formatFocusRefToken("job", r.value.id, show.job.title)}.`,
      ],
    };
  },
};
