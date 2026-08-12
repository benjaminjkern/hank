// THE chat turn — one turn for every user message. There is no flow column:
// profile intake is a derived per-turn prompt switch, and everything else is
// Hank with a thinner prompt.
//
// Two paths per invocation:
//
//   1. User sent a widget submission marker, or this is a silent entry:
//      the deterministic state machine drives. No agent turn.
//   2. User sent free-text chat: loop Hank turns until he stops calling tools
//      or hands off. On a handoff, the state machine takes the next step.
//
// This lives in procedures/ rather than agent/runtime/ because every line of it
// is a product decision: which body of the prompt to run, whether the profile is
// thin enough to elicit against, when the walkthrough state machine gets to
// drive, and what a tool having ended a company means. `runtime/` owns the
// machinery underneath (runHankTurn streams and persists a turn; runAgentTurn
// dispatches its tools) and knows none of that.

import type {
  ChatTurnRunner,
  EntryTarget,
  TurnEvent,
} from "@/server/agent/contracts";
import { buildHankSystem } from "@/server/agent/hank";
import { loadHankDiscoveryContext } from "@/server/agent/hank/discoveryContext";
import { loadHankProfileContext } from "@/server/agent/hank/profileContext";
import { loadHankShortlistBoardContext } from "@/server/agent/hank/shortlistBoardContext";
import { loadHankWatchlistContext } from "@/server/agent/hank/watchlistContext";
import {
  runHankTurn,
  type TranscriptInfo,
} from "@/server/agent/runtime/runHankTurn";
import { isProfileObviouslyEnriched } from "@/server/entities/profile/profileInventory";
import { loadRecentClientErrors } from "@/server/platform/clientEvents/recent";
import { withCaptureContext } from "@/server/platform/usage/captureContext";
import type {
  WalkthroughArgs,
  WalkthroughResult,
} from "@/server/procedures/registry/walkthrough";
import { runWalkthrough } from "@/server/procedures/registry/walkthrough";
import { parseWidgetSubmission } from "@/server/widgets/parse";

// Cap on agent turns within a single user-message invocation. Headroom for the
// CRUD-heavy case (create_job × N + log_event × N).
const MAX_AGENT_LOOPS = 20;

// The synthetic first user turn on a silent profile-intake entry. There's
// nothing for Hank to answer — the whole point is for him to open — and the API
// rejects a message list that ends on an assistant turn. Parenthesized so he
// reads it as a system nudge, not literal user words to echo. Never persisted.
const PROFILE_INTAKE_NUDGE = "(Starting profile setup — greet me and begin.)";

export const runChatTurn: ChatTurnRunner = async function* (args) {
  const isWidgetSubmission = !!parseWidgetSubmission(args.userMessage);

  // Did this message open a user turn? An empty composer still does when the
  // user's panel marks are the content — runChat wrote the row either way (see
  // openUserTurn); this is only the routing read of what it decided.
  const opensUserTurn = !!args.userMessage || args.carriesPanelEdits === true;

  // Derived once per message (a Postgres read of three memory slots, no LLM):
  // is the user's profile still too thin to match roles against? Drives both the
  // prompt body below and the silent-entry branch — a cold-start user with no
  // message needs Hank to greet and start eliciting, NOT the state machine
  // (which, with nothing to dispatch on, would yield "what's next" forever).
  const profileIntake = !(await isProfileObviouslyEnriched(args.userId));
  const profileIntakeEntry =
    !opensUserTurn && !args.entryTarget && profileIntake;

  // The turn opens with Hank rather than the state machine when there's an
  // instruction to open on: profile intake derives its own, and a caller can
  // thread one for a click whose whole meaning is "ask me about this" (the
  // what's-next chooser's add-companies row, the add-more widget's "Find more").
  const openingNudge =
    args.openingNudge ??
    (profileIntakeEntry ? PROFILE_INTAKE_NUDGE : undefined);

  // Path 1: widget submission OR silent entry — state machine drives. On a
  // picker-driven silent entry the target is threaded in (args.entryTarget); a
  // widget submission carries its ids in the marker (handleWidgetSubmission), so
  // entryTarget is undefined there and unused.
  if ((isWidgetSubmission || !opensUserTurn) && !openingNudge) {
    const result = yield* runStateMachine(args);
    yield {
      type: "done",
      wrappedUp: result.wrappedUp,
      endedCompanyId: result.endedCompanyId,
    };
    return;
  }

  // Path 2: free-text chat — loop Hank turns until he stops calling tools
  // (waiting on the user) or we hit MAX_AGENT_LOOPS. Multi-turn matters
  // for the CRUD-then-event pattern (Hank fires create_jobs, sees the
  // jobIds in the tool_result, then fires mark_job_applied / log_job_events
  // etc. on the next turn).
  //
  // THE INVARIANT (see AGENTS.md "nothing runs unless Hank hands off"): the
  // deterministic state machine advances ONLY when Hank explicitly hands off
  // this turn — a handoff tool ended his loop. A quiet free-text turn where he
  // just chatted (answered a question, asked one, ran read-only or CRUD tools
  // and went quiet) runs NOTHING after it: his reply stands and we wait for the
  // user. There is no behind-his-back re-derivation. The only other triggers
  // are Path 1 above — widget submissions and silent entry — which are
  // themselves explicit (a user click / a deterministic continuation).
  //
  // Handoff tools that reach the state machine here: company_walkthrough (the
  // machine runs that company's arm — reading, seeding the shortlist board, or
  // picking a role, whichever rung it lands on), work_on_job (the job arm),
  // find_companies (the discovery arm), show_whats_next (the top-level
  // chooser), scrape_jobs_for_company (new postings pulled; the machine scans
  // them), and commit_shortlist (the board just became real; the machine
  // continues into the role picker). Company set-asides are NOT here: close / pause / block /
  // caught-up are mutations that wrap their own segment and report `wrappedUp`,
  // which reaches what's-next without cutting Hank's reply off mid-sentence.
  //
  // Breaking the agent loop on a handoff also avoids a free post-action agent
  // turn — where Hank confabulated a fake on-screen role list (the "[Shown to
  // the user …]" reproduction). See HANDOFF_TOOLS.
  //
  let calledHandoffTool = false;
  // The entry target of the handoff tool that ended the loop — threaded to the
  // state machine as its entry target.
  let entryTarget: EntryTarget | undefined;
  // A close/pause/block/caught-up mutation ended a company this turn. Not a
  // handoff (it starts no sequence and must not cut Hank off mid-reply), but it
  // DID end something — so the segment wrap runs and what's-next fires, both
  // after his reply. First one wins; N closes in a turn is still one wrap.
  let endedCompanyId: string | undefined;
  for (let loop = 0; loop < MAX_AGENT_LOOPS; loop++) {
    const turn = yield* runHankTurn({
      ...args,
      buildSystem: (info) => buildTurnSystem(args, profileIntake, info),
      turnIndex: loop,
      ...(openingNudge && loop === 0 ? { openingNudge } : {}),
    });
    // Fold this turn's tool outcomes. runAgentTurn hands them back in dispatch
    // order and interprets neither — the two rules are domain policy: the LAST
    // handoff target wins (a turn firing several ends where the final one left
    // it), the FIRST company to end wins (the wrap is per-message, so any one of
    // them is the trigger).
    for (const d of turn.dispatched) {
      if (d.result?.entryTarget) entryTarget = d.result.entryTarget;
      if (d.result?.endedCompanyId && !endedCompanyId) {
        endedCompanyId = d.result.endedCompanyId;
      }
    }
    if (turn.calledHandoffTool) calledHandoffTool = true;
    if (!turn.agentCalledTool) break;
    if (turn.calledHandoffTool) break;
  }
  // Explicit handoff → the deterministic layer takes the next step. No guard is
  // needed against a competing surface: the deterministic layer owns every
  // wait-for-user surface, so no tool emits one of its own.
  if (calledHandoffTool) {
    const result = yield* runStateMachine({
      ...args,
      userMessage: "",
      entryTarget,
    });
    yield {
      type: "done",
      wrappedUp: result.wrappedUp,
      endedCompanyId: result.endedCompanyId,
    };
    return;
  }
  // Profile intake just finished. `commit_profile` is not a handoff tool (its
  // outcome decides whether setup is over, and `handoff` is a static flag), so
  // the completion is derived here instead: intake was on at entry and the
  // memory slots are now full, which only a passing commit_profile can cause.
  // Report it as a wrap so runChat brings up the what's-next chooser — the same
  // treatment every other completion gets.
  if (profileIntake && (await isProfileObviouslyEnriched(args.userId))) {
    yield { type: "done", wrappedUp: true };
    return;
  }
  // No handoff — Hank just chatted, so his reply stands. A company ending is the
  // one thing that still pulls up what's-next from this path: it was closed /
  // paused / blocked / caught-up, which finishes it wherever it was fired from.
  // The mutation only wrote the status; runChat runs the segment wrap and then
  // the chooser.
  //
  // Focus is ephemeral now (no sticky company), so there's nothing to "resume":
  // side-trip detection is gone. If the user wants to continue on a company
  // later, Hank re-engages it explicitly via company_walkthrough.
  yield { type: "done", wrappedUp: !!endedCompanyId, endedCompanyId };
};

// Assemble Hank's system prompt for this turn. Rebuilt per agent loop because
// the watchlist hint + client-error block go stale as the turn does work.
async function buildTurnSystem(
  args: Parameters<ChatTurnRunner>[0],
  profileIntake: boolean,
  transcript: TranscriptInfo,
) {
  const [
    watchlist,
    recentClientErrors,
    profileContext,
    shortlistBoards,
    discoveryList,
  ] = await Promise.all([
    loadHankWatchlistContext(args.userId),
    loadRecentClientErrors(args.sessionId),
    loadHankProfileContext(args.userId),
    loadHankShortlistBoardContext(args.userId),
    loadHankDiscoveryContext(args.userId),
  ]);
  return buildHankSystem({
    profileIntake,
    profileGaps: args.profileGaps,
    timeZone: args.timeZone,
    watchlist,
    recentClientErrors,
    profileContext,
    shortlistBoards,
    discoveryList,
    // The "picking up where we left off" banner — on iff the session already has
    // an assistant turn. (There's no "current focus" block anymore; focus is
    // ephemeral, so Hank works from the conversation + the clickable chips.)
    continuing: transcript.hasPriorAssistantTurn,
  });
}

// Run the state machine, with every sub-agent it drives stamped with this run.
//
// It persists nothing: the events it yields reach the user through
// recordTranscript, which writes them as they go. An outer buffer here used to
// collect and flush them at the end of the pass, which double-wrote everything
// the machine reached through a narrating procedure and stamped the copy with
// the time the pass ENDED — so a finished batch repeated itself at the bottom
// of the chat.
async function* runStateMachine(
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  const sm = runWalkthrough(args);
  while (true) {
    // Run-tree capture: wrap each generator STEP (not the generator body — ALS
    // can't survive a yield) so any sub-agent the state machine drives in this
    // step records the run's id. There's no messageId/parentToolUseId to set —
    // the state machine has no main-agent tool_use to nest under.
    // eslint-disable-next-line no-await-in-loop -- draining a generator — each step is produced by the previous one
    const next = await withCaptureContext({ runId: args.runId }, () =>
      sm.next(),
    );
    if (next.done) return next.value;
    yield next.value;
  }
}
