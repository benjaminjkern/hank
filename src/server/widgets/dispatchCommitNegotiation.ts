// "Looks good to me" pressed on a negotiation panel with nothing left to argue
// about — settle it without waking Hank.
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
// Refusing means returning `none`: the message falls through as ordinary free
// text and Hank answers it, seeing the marker's label plus whatever the relay
// carried. So the worst case of a stale button is the round trip it was trying
// to save — never a commit over a change he never saw.
//
// The application's submit is deliberately NOT here. "I submitted this" records
// something that already happened in the real world; these two settle a proposal
// that hasn't happened yet. They share the chrome and the gate, not the meaning
// — see widgets/parse.ts (confirm_application_submit).

import type { EntryTarget, RunContext } from "@/server/agent/contracts";
import { runCommitShortlist } from "@/server/procedures/registry/commitShortlist";
import { loadDiscoveryList } from "@/server/views/discoveryList";
import type { NegotiationState } from "@/server/views/negotiationPanel";
import { loadShortlistBoard } from "@/server/views/shortlistBoard";

import type { CommitNegotiationSubmission } from "./parse";

// Null when the panel is no longer in a state this may settle — the caller
// hands the message to Hank instead.
export async function dispatchCommitNegotiation(
  submission: CommitNegotiationSubmission,
  ctx: RunContext & { sessionId: string },
): Promise<EntryTarget | null> {
  if (submission.panel === "discovery") {
    const list = await loadDiscoveryList(ctx.userId);
    if (!settled(list)) return null;
    // The discovery arm owns the commit itself, exactly as it does when the
    // tool hands off — this only decides that it may run.
    return { kind: "discovery_commit" };
  }

  const board = await loadShortlistBoard(ctx.userId, submission.companyId);
  if (!board || !settled(board)) return null;
  const result = await runCommitShortlist({
    ...ctx,
    companyId: board.companyId,
    companyName: board.companySlug ?? board.companyName,
  });
  // Deliberately no `confirmed` here: the commit refuses a board that would
  // close a role the user had started applying to, and this path has no way to
  // ask them. Falling through hands the press to Hank as ordinary text, he hits
  // the same refusal on the tool — which spells out which roles and why — and
  // asks. Same shape as a stale button: the cost is the round trip this was
  // saving, never a close the user didn't agree to.
  if (!result.ok) return null;
  // The board closes with the commit, so the panel can't stay on it.
  return { kind: "company", id: board.companyId };
}

// Nothing left for Hank to react to: the surface is still settleable, the user
// has changed nothing since he last saw it, and nothing is waiting on an answer.
function settled(state: NegotiationState): boolean {
  return state.open && state.pendingCount === 0 && state.openThreadCount === 0;
}
