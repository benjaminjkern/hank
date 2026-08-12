// The one place the next_company_picker is rendered.
//
// runWhatsNext (procedures/registry/whatsNext.ts) walks the rungs and returns
// either "the rung-0 profile gate is still open" or the three option sections.
// This turns that verdict into chat: the gate branch narrates a
// transition cue and reports the gaps back so Hank can open on the specifics,
// and the pick branch emits the picker widget.
//
// Keeping both branches here is what stops the chooser drifting between the
// several ways of reaching it (a cold start, a wrap, a close/pause, Hank's
// show_whats_next handoff) — they all land on this function.

import { statusEvent, widgetEvent } from "@/server/agent/contracts";
import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { runWhatsNext } from "@/server/procedures/registry/whatsNext";

// The profile gatekeeper's read of what's thin — the weakest slots plus probe
// questions to ask about them. Threaded into the next chat turn so Hank opens on
// the specifics ("here's what I still need") instead of cold.
export type ProfileGaps = { missing: string[]; suggestedProbes: string[] };

export type WhatsNextRender =
  // Widget emitted; it waits on the user, so the caller stops here.
  | { kind: "rendered" }
  // The gate is open. The gaps are not persisted anywhere — the chat turn
  // re-derives intake from the same memory slots; they only sharpen what Hank
  // opens on.
  | { kind: "profile_gate_open"; gaps: ProfileGaps };

export async function* renderWhatsNext(
  args: RunContext & {
    sessionId: string;
    // A wrap just happened, so the user is owed a transition cue before the
    // gate's elicitation starts. Off on a cold start, where there's nothing to
    // transition FROM.
    narrateProfileSwitch: boolean;
  },
): AsyncGenerator<TurnEvent, WhatsNextRender> {
  const result = await runWhatsNext(args);
  if (result.kind === "profile") {
    if (args.narrateProfileSwitch) {
      // User-facing, goal-framed cue. "Switching to profile setup" read as
      // meaningless internal jargon (the user doesn't know "profile setup")
      // and jarred when it fired right after the user asked to see roles —
      // it sounded like being pulled away from their goal. Frame it as a
      // brief step toward matching them instead. The enrich-profile agent
      // greets right after, so this stays terse.
      yield statusEvent(
        "One sec — grabbing a couple quick details so I can match you well.",
      );
    }
    return {
      kind: "profile_gate_open",
      gaps: {
        missing: result.missing,
        suggestedProbes: result.suggestedProbes,
      },
    };
  }

  yield widgetEvent("next_company_picker", {
    immediate: result.options.immediate,
    deferred: result.options.deferred,
    backlog: result.options.backlog,
    empty: result.empty,
  });
  return { kind: "rendered" };
}
