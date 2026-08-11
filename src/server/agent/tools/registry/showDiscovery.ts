import { z } from "zod";

import { formatFocusRefToken } from "@/lib/focusRefToken";
import { buildDiscoveryEvents } from "@/server/views/showEvents";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// show_discovery — put the companies-to-add list back on the user's screen.
// PURE DISPLAY, the discovery sibling of show_company / show_job: it starts no
// search and settles no marks.
//
// It takes no arguments because a user has exactly one open list — the batch the
// last search proposed. Re-searching is find_companies; adding what's checked is
// commit_discovery.
export const showDiscoveryTool: ToolDef<Record<string, never>> = {
  name: "show_discovery",
  affectsViewedState: false,
  description:
    'Put the list of companies you last suggested back on the user\'s screen (right panel) and drop a clickable chip in the chat — pure display, no new search and nothing added. Use it when they ask to see the list again ("show me those companies", "what were the ones you found?", "bring that list back") after navigating the panel somewhere else. To look for DIFFERENT companies use find_companies; to add the ones they left checked use commit_discovery.',
  inputSchema: { type: "object", properties: {} },
  parser: z.object({}),
  async handle(_input, ctx) {
    const show = await buildDiscoveryEvents(ctx.userId);
    if (show.discovery.rows.length === 0) {
      return toolError(
        "ENTITY_NOT_FOUND",
        "there's no open list of suggested companies — either nothing has been proposed, or the user already settled the last batch. Offer to look for some (find_companies) rather than saying the list is missing.",
        "show_discovery:not_found:empty_list",
      );
    }
    const count = `${show.discovery.rows.length} ${show.discovery.rows.length === 1 ? "company" : "companies"}`;
    return {
      content: `Put the list of ${count} back on the user's screen. Nothing else happens — this is display only; they still have to settle it and you still have to call commit_discovery.`,
      events: show.events,
      statusLines: [
        `Pulled up ${formatFocusRefToken("discovery", null, count)}.`,
      ],
    };
  },
};
