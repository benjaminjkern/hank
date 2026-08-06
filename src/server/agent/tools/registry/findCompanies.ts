// find_companies — the single "grow the watchlist" discovery tool. Hands off to
// the deterministic discovery arm, which runs the runFindCompanies sub-agent
// (thesis + resume + the user's watchlist as signal + Hank's optional free-text
// `direction`; web_search + fetch_url available, the sub-agent decides) and puts
// the candidates on screen as a company_checklist to prune. Picked names
// round-trip through the top-level company_checklist dispatcher, which enriches
// them into the watchlist (URL hunt → scrape → PRE_SCAN).
//
// Named companies still go through create_companies — this is for "find me some"
// / "who else should I track?" where the user hasn't named anyone yet.
//
// The tool emits nothing itself: the arm owns the checklist, the empty-result
// line, and the failure line. `direction` is the steering channel and the ONLY
// one — the checklist has no re-search control of its own, so a user reacting to
// a batch ("too big", "more like Ramp") reaches the search only if Hank
// recognizes it as a re-run and calls again. Hence the reaction case spelled out
// in the description below.

import { z } from "zod";

import type { ToolDef } from "../lib/types";

export const findCompaniesTool: ToolDef<{ direction?: string }> = {
  name: "find_companies",
  affectsViewedState: false,
  handoff: true,
  description:
    'Find companies to add to the user\'s watchlist and show them an interactive checklist to prune. Use when the user wants ideas but HASN\'T named specific companies — "find me some companies", "who else should I be tracking?", "suggest a few", "look for X-type companies". It weighs the user\'s thesis + resume + their existing watchlist and can search the web; you don\'t supply the picks. `direction` (optional) is a free-text steer you pass from the conversation — the kind of companies they\'re after ("early-stage infra", "remote-first climate", "companies that hire staff backend ICs") OR a refinement of a previous run ("actually, more early-stage"); to change the results, call again with a new direction. **A REACTION TO A CHECKLIST YOU JUST SHOWED IS A RE-RUN, not something to reply to.** When the user pushes back on a batch — "these are all too big", "not these", "more like Ramp", "none of them are remote" — call this again with what they said as the direction; don\'t answer in prose and wait, because the checklist has no re-search button and they are asking you to look again. Candidates they never answered come back automatically when they still fit, so a re-run doesn\'t lose the ones they liked. If the user NAMED specific companies ("add Stripe and Linear"), use create_companies instead — don\'t use this for that. Acknowledge in your text reply BEFORE calling ("On it — let me pull together some companies.") since the search takes a moment, then call this. After it shows the checklist, STOP — don\'t list the companies in chat, the widget handles it.',
  inputSchema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        description:
          "Optional free-text steer: what kind of companies the user is after (sector / stage / role-shape / a hard filter like 'remote-first'), or a refinement of a previous run. Omit to work from the user's thesis alone. Plain language — no enum codes or internal terms.",
      },
    },
  },
  parser: z.object({ direction: z.string().optional() }),
  async handle(input) {
    return {
      content:
        "Handed off to the company search. It puts a checklist of candidates on screen for the user to prune (or says so if nothing new turned up). Nothing more to do this turn — don't list any companies in chat.",
      entryTarget: { kind: "discovery", direction: input.direction },
    };
  },
};
