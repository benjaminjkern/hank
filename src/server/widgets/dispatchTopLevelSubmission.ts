// Dispatch for the TOP-LEVEL widget submissions — the ones runUserMessage
// handles before Hank runs at all, because the user's message is a structured
// choice rather than free text worth routing through the LLM.
//
// "Top-level" is the whole distinction: these widgets can be emitted from
// anywhere (a find_companies checklist can land in any conversation), so their
// picks have to commit the same way regardless of what was happening when they
// were shown. The walkthrough's own widgets — next_job_picker,
// confirm_revive_company and friends — are dispatched inside its state machine
// instead and never reach here; only their parsers are shared (widgets/parse.ts).
//
// Order matters where two branches could both match a message: they can't, since
// each parser keys on its own marker kind. It's listed in the order a discovery
// round runs — checklist, then any name collision it flagged, then add-more.
//
// Every branch does the same two things: run its deterministic dispatch, and
// report back what the caller should do next (TopLevelSubmissionOutcome).
// Nothing here calls an LLM to decide anything, and nothing here writes the
// user's row — runChat has already done that (see runChat's step 1).

import { statusEvent, yieldUiEvents } from "@/server/agent/contracts";
import type {
  EntryTarget,
  RunContext,
  TurnEvent,
} from "@/server/agent/contracts";
import {
  addMoreCompaniesWidget,
  runDisambiguationResolution,
} from "@/server/procedures/registry/enrichCompanies";
import { runWrapSegment } from "@/server/procedures/registry/wrapSegment";
import { showTargetFor, buildShowEvents } from "@/server/views/showEvents";
import { dispatchNextCompanyPicker } from "@/server/widgets/dispatchNextCompanyPicker";
import {
  parseNextCompanyPickerSubmission,
  parseAddMoreCompaniesSubmission,
  parseCompanyDisambiguationSubmission,
} from "@/server/widgets/parse";

// "Find more" says they want another round, not what it should contain.
const FIND_MORE_NUDGE =
  "(They just finished adding companies and want another round. Ask what to look for this time — a different sector, stage, or angle from the batch they just saw. Don't search yet.)";

export type TopLevelSubmissionArgs = RunContext & {
  sessionId: string;
  userMessage: string;
};

// What the caller does after this generator drains.
export type TopLevelSubmissionOutcome =
  // Not a top-level submission — the message is still the user's to route.
  | { kind: "none" }
  // Fully handled, and what it emitted waits on the user (a widget, or a batch
  // of ✓ lines with nothing queued behind them). The turn ends here.
  | { kind: "terminal" }
  // The user picked a destination. Run the chat turn on `entryTarget` as a
  // silent entry — no "what's next", they just answered that question. An
  // absent target means the pick had nothing to dispatch on (add-companies, or
  // a stale row), which the state machine's no-target branch handles.
  | { kind: "enter"; entryTarget?: EntryTarget }
  // A mutation committed and consumed the message. Nothing is typed and no
  // destination was named, so the caller falls through to its normal
  // no-message path.
  | { kind: "consumed" }
  // The click's whole meaning was "ask me about this" — there's no destination
  // and no text to answer, so Hank opens the next turn on this instruction
  // rather than the deterministic layer taking a silent entry (which, with
  // nothing to run on, would just re-render what they clicked out of).
  | { kind: "ask"; openingNudge: string };

export async function* dispatchTopLevelSubmission(
  args: TopLevelSubmissionArgs,
): AsyncGenerator<TurnEvent, TopLevelSubmissionOutcome> {
  const { userId, sessionId, userMessage } = args;

  // The user resolved a name collision the URL hunter flagged during a checklist
  // add. Commit each chosen board + scrape + prescan, narrate ✓ — then the same
  // add-more question, since this is the tail of the same add.
  const disambiguationSubmission =
    parseCompanyDisambiguationSubmission(userMessage);
  if (disambiguationSubmission) {
    const added = yield* runDisambiguationResolution(
      disambiguationSubmission.resolved,
      args,
    );
    yield addMoreCompaniesWidget(added, 0);
    return { kind: "terminal" };
  }

  // "Find more" / "Done adding" after a finished add. More asks what to look for
  // this time before searching — they've just seen a batch, so "more" with no
  // steer returns names adjacent to the ones they passed on; done falls through
  // to what's next.
  const addMoreSubmission = parseAddMoreCompaniesSubmission(userMessage);
  if (addMoreSubmission) {
    if (addMoreSubmission.answer === "yes") {
      return { kind: "ask", openingNudge: FIND_MORE_NUDGE };
    }
    // Done adding is a topic boundary — the same event the end of a company is,
    // so it gets the same wrap. Gated on the round having decided something:
    // opening discovery and backing straight out is not a boundary, and the
    // wrap costs two LLM calls.
    if (addMoreSubmission.settled > 0) {
      await runWrapSegment({ ...args, subject: "discovery" });
    }
    return { kind: "consumed" };
  }

  // The between-things "what's next" picker. The submission already encodes the
  // destination (company / opp / job / add-companies) — dispatch it, emit the
  // "Picking up X." line, open the panel on it, and hand the resulting
  // entryTarget back for the chat turn to run on.
  const pickerSubmission = parseNextCompanyPickerSubmission(userMessage);
  if (pickerSubmission) {
    const dispatch = await dispatchNextCompanyPicker({
      userId,
      sessionId,
      submission: pickerSubmission,
    });
    if (dispatch.kind === "ask") {
      return { kind: "ask", openingNudge: dispatch.openingNudge };
    }
    yield statusEvent(dispatch.statusText);
    yield* yieldUiEvents(
      (await buildShowEvents(userId, showTargetFor(dispatch.entryTarget)))
        .events,
    );
    return { kind: "enter", entryTarget: dispatch.entryTarget };
  }

  return { kind: "none" };
}
