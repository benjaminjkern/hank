// The `hank` entry: Hank takes the turn. Loops agent turns until he stops
// calling tools or hands off — a handoff tool queued an Entry, which is this
// step's `next`. There is no other way out of here into deterministic work: a
// turn where he just chatted (answered, asked, ran reads or record-only writes)
// ends with his reply standing and nothing queued.
//
// Ending his loop on a handoff is also the guard against a free post-action
// turn, where he'd narrate (and invent) a surface the procedure hasn't drawn yet.
//
// This lives in procedures/ rather than agent/runtime/ because it makes product
// calls: which prompt body to run (profile intake is a derived per-turn switch,
// not a mode), what's on screen, and that finishing profile setup brings up the
// chooser. `runtime/` streams and persists a turn and knows none of that.

import { buildHankSystem } from "@/server/agent/hank";
import { loadHankDiscoveryContext } from "@/server/agent/hank/discoveryContext";
import { loadHankProfileContext } from "@/server/agent/hank/profileContext";
import { loadHankShortlistBoardContext } from "@/server/agent/hank/shortlistBoardContext";
import { loadHankWatchlistContext } from "@/server/agent/hank/watchlistContext";
import {
  runHankTurn,
  type TranscriptInfo,
} from "@/server/agent/runtime/runHankTurn";
import type {
  Entry,
  ProfileGaps,
  Segment,
  StepArgs,
  StepOutcome,
} from "@/server/contracts";
import { isProfileObviouslyEnriched } from "@/server/entities/profile/profileInventory";
import { loadRecentClientErrors } from "@/server/platform/clientEvents/recent";
import { procedure } from "@/server/procedures/lib/procedure";

// Cap on agent turns within one step. Headroom for the CRUD-heavy case
// (create_job × N + log_event × N).
const MAX_AGENT_LOOPS = 20;

type HankTurnsArgs = StepArgs & {
  // The synthetic opening when there's no user row to answer (see Entry).
  nudge?: string;
  profileGaps?: ProfileGaps;
  // The right panel's URL path, so "this one" resolves to what's on screen.
  panelPath?: string;
};

export const runHankTurns = procedure(
  "hank_turns",
  async (args: HankTurnsArgs): Promise<StepOutcome> => {
    // Derived once per step (a Postgres read of three memory slots, no LLM): is
    // the profile still too thin to match roles against? Picks the prompt body.
    const profileIntake = !(await isProfileObviouslyEnriched(args.userId));

    let next: Entry | undefined;
    // The first company a tool ended wins; N closes in one step is still one
    // wrap-up, which the chat loop runs once for the whole message anyway.
    let ended: Segment | undefined;
    for (let loop = 0; loop < MAX_AGENT_LOOPS; loop++) {
      // eslint-disable-next-line no-await-in-loop -- each agent turn reads the tool results the previous one produced
      const turn = await runHankTurn({
        ...args,
        buildSystem: (info) => buildTurnSystem(args, profileIntake, info),
        turnIndex: loop,
        ...(args.nudge && loop === 0 ? { openingNudge: args.nudge } : {}),
      });
      // Stop means stop: nothing he queued runs.
      if (turn.stopped) return { stopped: true };
      for (const d of turn.dispatched) ended ??= d.result?.ended;
      if (turn.queued) {
        next = turn.queued;
        break;
      }
      if (!turn.agentCalledTool) break;
    }

    // Profile setup just finished: intake was on at entry and the memory slots
    // are now full, which only a passing commit_profile can cause. That ends the
    // setup sequence, and the chooser is what comes after it.
    if (
      !next &&
      profileIntake &&
      (await isProfileObviouslyEnriched(args.userId))
    ) {
      next = { kind: "show_whats_next" };
    }
    return { ...(next ? { next } : {}), ...(ended ? { ended } : {}) };
  },
);

// Assemble Hank's system prompt for this turn. Rebuilt per agent loop because
// the watchlist hint + client-error block go stale as the turn does work.
async function buildTurnSystem(
  args: HankTurnsArgs,
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
    panelPath: args.panelPath,
    // The "picking up where we left off" banner — on iff the session already has
    // an assistant turn. (Focus is ephemeral: Hank works from the conversation,
    // the clickable chips, and what's on screen.)
    continuing: transcript.hasPriorAssistantTurn,
  });
}
