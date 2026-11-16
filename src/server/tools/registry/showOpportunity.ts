import { z } from "zod";

import { sayUiEvents, statusEvent } from "@/server/contracts";
import { resolveOpportunityBySlug } from "@/server/entities/resolveBySlug";
import { toolError } from "@/server/platform/agent/toolError";
import { buildShowEvents } from "@/server/views/showEvents";
import { formatFocusRefToken } from "@/shared/focusRefToken";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// show_opportunity — put a lead's page on the user's screen + drop a clickable
// chip. PURE DISPLAY (see show_company). Non-handoff; chip is view-only.
export const showOpportunityTool: ToolDef<{ opportunity: string }> = {
  name: "show_opportunity",
  affectsViewedState: false,
  description:
    "Put an inbound lead's page on the user's screen (right panel) and drop a clickable chip in the chat — a pure display action that starts no work and changes nothing. Use it when you're referring to a recruiter lead / inbound opportunity and want the user to see it. `opportunity` is the lead's slug.",
  parser: z.object({ opportunity: z.string().describe("The lead's slug.") }),
  async handle(input, ctx) {
    const r = await resolveOpportunityBySlug(ctx.userId, input.opportunity);
    if (!r.ok) return slugLookupError(r, { source: "show_opportunity" });
    const show = await buildShowEvents(ctx.userId, {
      opportunityId: r.value.id,
    });
    if (!show.opportunity) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `couldn't load the page for "${input.opportunity}"`,
        "show_opportunity:not_found:opportunity",
      );
    }
    await sayUiEvents(ctx.say, show.events);
    await ctx.say(
      statusEvent(
        `Pulled up ${formatFocusRefToken("opportunity", r.value.id, show.opportunity.label)}.`,
      ),
    );
    return {
      content: `Put ${r.value.slug}'s page on the user's screen. Nothing else happens — this is display only.`,
    };
  },
};
