import { z } from "zod";

import { formatFocusRefToken } from "@/lib/focusRefToken";
import { resolveOpportunityBySlug } from "@/server/entities/resolveBySlug";
import { buildShowEvents } from "@/server/views/showEvents";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// show_opportunity — put a lead's page on the user's screen + drop a clickable
// chip. PURE DISPLAY (see show_company). Non-handoff; chip is view-only.
export const showOpportunityTool: ToolDef<{ opportunity: string }> = {
  name: "show_opportunity",
  affectsViewedState: false,
  description:
    "Put an inbound lead's page on the user's screen (right panel) and drop a clickable chip in the chat — a pure display action that starts no work and changes nothing. Use it when you're referring to a recruiter lead / inbound opportunity and want the user to see it. `opportunity` is the lead's slug.",
  inputSchema: {
    type: "object",
    properties: {
      opportunity: { type: "string", description: "The lead's slug." },
    },
    required: ["opportunity"],
  },
  parser: z.object({ opportunity: z.string() }),
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
    return {
      content: `Put ${r.value.slug}'s page on the user's screen. Nothing else happens — this is display only.`,
      events: show.events,
      statusLines: [
        `Pulled up ${formatFocusRefToken("opportunity", r.value.id, show.opportunity.label)}.`,
      ],
    };
  },
};
