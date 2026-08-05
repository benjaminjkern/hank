// show_whats_next — hand back to the deterministic layer at a "what should I do
// next?" moment.
//
// It is NOT a flow entry (it starts no work) and it emits no widget. It's the
// between-things signal: the system can't tell "I'm handing back, show the
// chooser" from "I'm asking the user a real question" from the outside, but Hank
// can, so he says so by calling this instead of typing the question.
//
// handoff:true with no entryTarget → the state machine's no-target branch runs,
// which wraps and lets runUserMessage render the chooser through the SAME
// runWhatsNext path a close/pause/caught-up wrap uses. That's the point of
// routing it this way rather than emitting the widget here: one renderer, so the
// chooser can't drift between the two ways of reaching it.

import { z } from "zod";

import type { ToolDef } from "../lib/types";

export const showWhatsNextTool: ToolDef<Record<string, never>> = {
  name: "show_whats_next",
  handoff: true,
  description:
    'Pull up the user\'s TOP-LEVEL "what\'s next" chooser — the between-things picker of the companies / roles / leads across their whole watchlist they could pick up next, plus an option to add more companies. This is the top-of-the-funnel "what should I work on" chooser, NOT the list of roles inside one company (call company_walkthrough on that company for those) and NOT a mid-walkthrough / mid-application move. Call it INSTEAD of typing "what do you want to look at next?" whenever the user has finished the current thing and wants to move on but hasn\'t named a specific next company: after an interview debrief / offer talk, after capturing a side-trip, or any "what else do I have / what should I work on / show me my options" moment where nothing is actively in progress. Do NOT call it while you\'re still mid-work on a company or role, right after a close_company / pause_company (those already bring the chooser up on their own — calling it again would double it), or when the user asked a specific question you should just answer. Include a brief natural lead in your text first ("Here\'s what\'s on your plate —") and never name "the picker"/"widget"; then call this and STOP.',
  inputSchema: { type: "object", properties: {} },
  parser: z.object({}).strict(),
  async handle() {
    return {
      content:
        "Handed back to bring up the what's-next chooser. Nothing more to do this turn — don't list the options in chat.",
    };
  },
};
