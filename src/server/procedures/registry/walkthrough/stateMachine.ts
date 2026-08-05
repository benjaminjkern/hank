// Walkthrough deterministic state machine. Dispatched on the entry target the
// caller threads in (a handoff tool's entryTarget, or a picker dispatch):
//
//   company     → company arm: revive-confirm if it was set aside, else prescan
//                 unscanned jobs, scan, shortlist, offer the remaining roles,
//                 mark CAUGHT_UP if nothing is left.
//   job         → job arm: fetch application form, draft cover letter + short
//                 answers, wait for submit.
//   opportunity → opportunity arm (stub).
//   none        → "what's next" (the caller renders the chooser).
//
// runChatTurn invokes this on a handoff, a widget submission, or a silent entry.
// Each call re-derives its position from the DB — we never persist a step
// number, so re-entering just lands on the first thing that still needs doing.
//
// One file per piece, all in this folder: the four arms (companyArm / jobArm /
// discoveryArm / opportunityArm), the two on-entry board steps the company arm
// chooses between (companyEnrichStep / boardScrape), the dispatcher, the
// widget-submission handler, and four leaves (pendingWidgets /
// summarizeCloseRationales / narration / yieldStateChange).

import type { TurnEvent } from "@/server/agent/contracts";
import { parseWidgetSubmission } from "@/server/widgets/parse";

import { dispatchByEntryTarget } from "./dispatchByEntryTarget";
import { handleWidgetSubmission } from "./handleWidgetSubmission";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

export async function* runWalkthrough(
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  // Handle widget submission first — these are deterministic state
  // transitions, not free-text chat. parseWidgetSubmission returns null for
  // regular text messages.
  const submission = parseWidgetSubmission(args.userMessage);
  if (submission) {
    return yield* handleWidgetSubmission(submission, args);
  }

  // No widget submission — dispatch on the entry target. Reaching here means a
  // handoff, a silent entry, or a deterministic continuation; free-text user
  // messages are answered by Hank in runChatTurn, not here.
  return yield* dispatchByEntryTarget(args);
}
