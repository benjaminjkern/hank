// "Looks good to me" pressed on a negotiation panel with nothing left to argue
// about — settle it without waking Hank. Not a widget: a panel's commit, sent
// the same way. Typed equivalents: commit_shortlist / commit_discovery.
//
// The press is a structured choice, not a message: the user is agreeing with a
// proposal that is already on their screen, so routing it through the LLM buys
// a turn in which he reads the panel, agrees with himself, and calls the commit
// tool. The tools stay — Hank still commits when the user says "looks good" in
// chat — and both paths enter the same procedure.
//
// THE GUARD IS HERE, NOT ON THE BUTTON. The panel labels itself from the last
// payload it fetched, which can be stale by the time of the click, so this
// re-derives both counts from the database and refuses if either is non-zero.
// Refusing means returning null: the message falls through as ordinary free
// text and Hank answers it, seeing the marker's label plus whatever the relay
// carried. So the worst case of a stale button is the round trip it was trying
// to save — never a commit over a change he never saw.
//
// The application's submit is deliberately NOT here. "I submitted this" records
// something that already happened in the real world; these two settle a proposal
// that hasn't happened yet. They share the chrome and the gate, not the meaning
// — see widgets/parse.ts (confirm_application_submit).

import { sayUiEvents } from "@/server/contracts";
import type { StepArgs, StepOutcome } from "@/server/contracts";
import { buildShowEvents } from "@/server/panels/showEvents";
import { runCommitShortlist } from "@/server/procedures/registry/commitShortlist";
import { loadDiscoveryList } from "@/server/views/discoveryList";
import { loadShortlistBoard } from "@/server/views/shortlistBoard";
import type { NegotiationState } from "@/shared/views/negotiationPanel";

import {
  parseCommitNegotiationSubmission,
  type CommitNegotiationSubmission,
} from "../widgets/parse";

import type { WidgetAnswerDef } from "../widgets/registry/types";

export const commitNegotiationAnswer: WidgetAnswerDef<CommitNegotiationSubmission> =
  {
    parse: parseCommitNegotiationSubmission,
    answer: async (submission, args) => {
      const next = await settle(submission, args);
      if (!next) return null;
      // Move the panel off the surface that just settled — it has nothing left
      // to decide, so leaving it up offers a dead screen. What runs next may
      // move it again; this is the one move that has to happen either way.
      const companyId =
        next.kind === "company_walkthrough" ? next.companyId : undefined;
      await sayUiEvents(
        args.say,
        (await buildShowEvents(args.userId, { companyId })).events,
      );
      return { next };
    },
  };

// Null when the panel is no longer in a state this may settle.
async function settle(
  submission: CommitNegotiationSubmission,
  ctx: StepArgs,
): Promise<StepOutcome["next"] | null> {
  if (submission.panel === "discovery") {
    const list = await loadDiscoveryList(ctx.userId);
    if (!settled(list)) return null;
    // The discovery commit owns the write itself, exactly as it does when Hank
    // queues it — this only decides that it may run.
    return { kind: "commit_discovery" };
  }

  const board = await loadShortlistBoard(ctx.userId, submission.companyId);
  if (!board || !settled(board)) return null;
  const result = await runCommitShortlist({
    ...ctx,
    companyId: board.companyId,
    companyName: board.companySlug ?? board.companyName,
    // The footer asks about closing a started application itself (a two-tap
    // confirm naming the roles) and sends `confirmed` only after the user said
    // go — the same meaning as Hank's confirmed:true re-call. An UNconfirmed
    // press that still hits the gate (the payload was stale) falls through to
    // Hank as ordinary text; he hits the same refusal on the tool and asks.
    // Same shape as a stale button: the cost is the round trip this was
    // saving, never a close the user didn't agree to.
    confirmed: submission.confirmed,
  });
  if (!result.ok) return null;
  // The board closes with the commit. A continuation: the commit's tail
  // surfaces what the round produced — it must not start new work at the
  // company (no re-scrape).
  return {
    kind: "company_walkthrough",
    companyId: board.companyId,
    continuation: true,
  };
}

// Nothing left for Hank to react to: the surface is still settleable, the user
// has changed nothing since he last saw it, and nothing is waiting on an answer.
function settled(state: NegotiationState): boolean {
  return state.open && state.pendingCount === 0 && state.openThreadCount === 0;
}
