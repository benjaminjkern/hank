import { statusEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";

import { runCompanyArm } from "./companyArm";
import { runDiscoveryArm } from "./discoveryArm";
import { runJobArm } from "./jobArm";
import { runOpportunityArm } from "./opportunityArm";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// Route the pass to an arm on the entry target the caller threaded in.
export async function* dispatchByEntryTarget(
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  // Dispatch signal: the entity to run the arm on, threaded in-memory from the
  // picker dispatch / handoff tool that triggered this pass (focus is ephemeral —
  // there's no slot to read). Undefined on a fall-through (e.g. an unknown widget
  // submission) → "what's next".
  const target = args.entryTarget;
  if (target?.kind === "job") {
    return yield* runJobArm(target.id, args);
  }
  if (target?.kind === "company") {
    // Walk only — the machine is never handed a company it's meant to FINISH.
    // The segment wrap belongs to runUserMessage, which fires it off the
    // endedCompanyId a mutation reports.
    return yield* runCompanyArm(target.id, args, target.direction);
  }
  if (target?.kind === "opportunity") {
    return yield* runOpportunityArm(target.id, args);
  }
  if (target?.kind === "discovery") {
    return yield* runDiscoveryArm(target.direction, args);
  }
  // No focus — typically after a skip/defer/caught-up wrap clears it. The
  // runner will call handleWhatsNext upstream and render the next-company
  // picker; narrate that explicitly so the gap between Hank's wrap text and
  // the widget appearing reads as "what's next is loading," not as "Hank is
  // doing some inscrutable check." (Rung 0's runProfileEnrichmentCheck check
  // is the only LLM call, and only fires when memory looks borderline.)
  //
  // Phrasing matches the WRAP_DEBRIEF suffix on bundled-action narrations so
  // the post-action chrome reads the same whether the path was wrap →
  // picker (caughtUpCompany / closeCompany / pauseCompany via runCompanyArm)
  // or standalone-status → picker (this branch, when focus was already
  // null at state-machine entry).
  yield statusEvent("Pulling up what's next…");
  return { wrappedUp: true };
}
