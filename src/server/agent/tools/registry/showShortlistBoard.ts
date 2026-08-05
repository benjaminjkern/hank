import { z } from "zod";

import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { renderShortlistBoardText } from "@/server/views/shortlistBoard";
import { buildShortlistBoardEvents } from "@/server/views/showEvents";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// show_shortlist_board — put a company's shortlist board on the user's screen
// and read it back in full (every tier, closed rows included). The show_*
// sibling for the board: display + read, starts no work, changes no state.
export const showShortlistBoardTool: ToolDef<{ company: string }> = {
  name: "show_shortlist_board",
  affectsViewedState: false,
  description:
    "Put a company's shortlist board on the user's screen (right panel) and read back every tier — the current picks/borderline/pass stances plus every role earlier passes set aside, each with its reason. Use it to pick a negotiation back up, to answer 'why isn't X on the list?', or to check what was filtered before reconsidering something with update_shortlist_proposal. Pure display + read: starts no work, changes nothing. `company` is the company's slug.",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "The company's slug." },
    },
    required: ["company"],
  },
  parser: z.object({ company: z.string() }),
  async handle(input, ctx) {
    const r = await resolveCompanyBySlug(ctx.userId, input.company);
    if (!r.ok) return slugLookupError(r);
    const { events, board } = await buildShortlistBoardEvents(
      ctx.userId,
      r.value.id,
    );
    if (!board) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `couldn't load a shortlist board for "${input.company}"`,
        "show_shortlist_board:not_found:company",
      );
    }
    return {
      content: `Put the ${board.companyName} shortlist board on the user's screen.\n\n${renderShortlistBoardText(board, { full: true })}`,
      events,
      statusLines: [`Pulled up the shortlist board for ${board.companyName}.`],
    };
  },
};
