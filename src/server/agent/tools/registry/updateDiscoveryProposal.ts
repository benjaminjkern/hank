import { z } from "zod";

import { CompanySuggestionMark } from "@/generated/prisma/client";
import { setAgentSuggestionMark } from "@/server/entities/companies/suggestionMark";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

const MARK_WORDS = ["add", "pass"] as const;
const MARK_FOR: Record<(typeof MARK_WORDS)[number], CompanySuggestionMark> = {
  add: CompanySuggestionMark.ADD,
  pass: CompanySuggestionMark.PASS,
};

// update_discovery_proposal — move ONE company's mark on the open discovery
// list. Discovery's counterpart to update_shortlist_proposal, and the same dual
// role: naming a company that isn't on the list is how it JOINS, so this is the
// add gesture as well as the check/uncheck one.
//
// `company` is a NAME, not a slug — a candidate is a proposal, not an entity, so
// there is nothing minted to address it by yet.
//
// Negotiation state only: nothing is added to the watchlist and no company is
// declined until commit_discovery settles the list.
export const updateDiscoveryProposalTool: ToolDef<{
  company: string;
  mark: (typeof MARK_WORDS)[number];
  reason: string;
}> = {
  name: "update_discovery_proposal",
  description:
    'Mark one company on the OPEN list of companies to add: \'add\' (checked — goes on the watchlist when the list is committed) or \'pass\' (unchecked). Use it when the user tells you in chat instead of clicking: "drop H", "I don\'t want that one", "actually keep Cohere". Naming a company that ISN\'T on the list PUTS IT THERE with that mark — that\'s how you add one they mentioned ("add Ramp to that list too"). Nothing is committed by this: the watchlist only changes when you call commit_discovery. There is no list open? Then this is not the tool — a company the user names outright goes straight on the watchlist with create_companies, and a fresh set of ideas is find_companies. `company` is the name as it appears on the list; `reason` is the one short user-facing sentence shown next to it.',
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description:
          "The company's name, as it appears on the list (or the new name to put on it).",
      },
      mark: {
        type: "string",
        enum: MARK_WORDS as readonly string[] as string[],
        description:
          "'add' = checked, goes on the watchlist at commit. 'pass' = unchecked, recorded as declined at commit so the search stops proposing it.",
      },
      reason: {
        type: "string",
        description:
          "One short user-facing sentence for the row — why it's marked this way. Natural language, no jargon. It replaces whatever the row said before, so write it for someone reading the list cold.",
      },
    },
    required: ["company", "mark", "reason"],
  },
  parser: z.object({
    company: z.string(),
    mark: z.enum(MARK_WORDS),
    reason: z.string(),
  }),
  async handle(input, ctx) {
    const result = await setAgentSuggestionMark({
      userId: ctx.userId,
      name: input.company,
      mark: MARK_FOR[input.mark],
      reason: input.reason,
    });
    if (!result) {
      return toolError(
        "GATE_BLOCKED",
        "there's no open list of companies to add, so there's nothing to mark. Use create_companies if the user named a company to track, or find_companies to go looking for some.",
        "update_discovery_proposal:gate:no_open_list",
      );
    }
    return {
      content: result.added
        ? `Put ${result.name} on the list, marked ${input.mark}. The list updates on the user's screen; nothing is final until commit_discovery.`
        : `Marked ${result.name} ${input.mark} on the list. The list updates on the user's screen; nothing is final until commit_discovery.`,
    };
  },
};
