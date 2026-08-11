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
// Every branch does the same three things: persist the user's message, run its
// deterministic dispatch, and report back what the caller should do next
// (TopLevelSubmissionOutcome). Nothing here calls an LLM to decide anything.

import { yieldUiEvents } from "@/server/agent/contracts";
import type {
  EntryTarget,
  RunContext,
  TurnEvent,
} from "@/server/agent/contracts";
import { appendUserMessage, narrateStatus } from "@/server/agent/session";
import {
  promptAddMoreCompanies,
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

import { buildPanelEditBlocks } from "./panelEditRelay";

export type TopLevelSubmissionArgs = RunContext & {
  sessionId: string;
  userMessage: string;
  attachmentIds: string[];
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
  | { kind: "consumed" };

export async function* dispatchTopLevelSubmission(
  args: TopLevelSubmissionArgs,
): AsyncGenerator<TurnEvent, TopLevelSubmissionOutcome> {
  const { userId, sessionId, userMessage, attachmentIds, runId } = args;

  // The user resolved a name collision the URL hunter flagged during a checklist
  // add. Commit each chosen board + scrape + prescan, narrate ✓ — then the same
  // add-more question, since this is the tail of the same add.
  const disambiguationSubmission =
    parseCompanyDisambiguationSubmission(userMessage);
  if (disambiguationSubmission) {
    await appendUserMessage(sessionId, userMessage, attachmentIds, {
      runId,
      leadingBlocks: await buildPanelEditBlocks(userId),
    });
    const added = yield* runDisambiguationResolution(
      disambiguationSubmission.resolved,
      args,
    );
    yield* promptAddMoreCompanies(added, 0, args);
    return { kind: "terminal" };
  }

  // "Find more" / "Done adding" after a finished add. More re-enters the search
  // with no direction (the watchlist just grew, so a fresh run reads
  // differently); done falls through to what's next.
  const addMoreSubmission = parseAddMoreCompaniesSubmission(userMessage);
  if (addMoreSubmission) {
    await appendUserMessage(sessionId, userMessage, attachmentIds, {
      runId,
      leadingBlocks: await buildPanelEditBlocks(userId),
    });
    if (addMoreSubmission.answer === "yes") {
      return { kind: "enter", entryTarget: { kind: "discovery" } };
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
    await appendUserMessage(sessionId, userMessage, attachmentIds, {
      runId,
      leadingBlocks: await buildPanelEditBlocks(userId),
    });
    const dispatch = await dispatchNextCompanyPicker({
      userId,
      sessionId,
      submission: pickerSubmission,
    });
    yield* narrateStatus(sessionId, dispatch.statusText, runId);
    yield* yieldUiEvents(
      (await buildShowEvents(userId, showTargetFor(dispatch.entryTarget)))
        .events,
    );
    return { kind: "enter", entryTarget: dispatch.entryTarget };
  }

  return { kind: "none" };
}
