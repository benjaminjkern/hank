// What one user message MEANS — the whole product sequence, from the moment the
// run is open to the moment the stream has nothing left to say.
//
// In order: promote anything that came due, let a widget submission commit
// itself, ask what's next when there's nothing to run on, then drive chat turns
// until one waits on the user. The wrap fires in here too, once, when a turn
// reports a company ended.
//
// The run itself — the API-key gate, the concurrency claim, the AbortController,
// the runId — belongs to runtime/runUserMessage.ts, which wraps this. The split
// is deliberate: that file is true of any message regardless of what it says,
// while every branch below is a decision about companies, roles, and profiles.

import { yieldUiEvents } from "@/server/agent/contracts";
import type {
  EntryTarget,
  RunContext,
  TurnEvent,
} from "@/server/agent/contracts";
import { listUnrelayedBoardEdits } from "@/server/entities/jobs/boardStance";
import { flipDueInterviewsToDebrief } from "@/server/entities/jobs/flipDueInterviews";
import { runWrapSegment } from "@/server/procedures/registry/wrapSegment";
import { buildShowEvents } from "@/server/views/showEvents";
import { dispatchTopLevelSubmission } from "@/server/widgets/dispatchTopLevelSubmission";
import {
  renderWhatsNext,
  type ProfileGaps,
} from "@/server/widgets/renderWhatsNext";

import { runChatTurn } from "./runChatTurn";

// Safety cap on the silent wrappedUp → run-again chain so a runaway
// wrap/re-enter cycle can't loop forever within one user message.
const MAX_SILENT_TRANSITIONS = 6;

export type ChatArgs = RunContext & {
  sessionId: string;
  userMessage: string;
  attachmentIds: string[];
};

export async function* runChat(args: ChatArgs): AsyncGenerator<TurnEvent> {
  // Promote any INTERVIEW_SCHEDULED whose interview date has passed to
  // INTERVIEW_DEBRIEF before any routing, so "user owes a debrief" surfaces on
  // THIS message (renderWhatsNext's Immediate section) rather than only when the
  // user happens to open the dashboard / a detail panel.
  // Best-effort + idempotent (see flipDueInterviews.ts).
  await flipDueInterviewsToDebrief();

  let userMessage = args.userMessage;
  let attachmentIds = args.attachmentIds;
  // The entity a picker dispatch wants the ensuing silent-entry turn to dispatch
  // on — threaded in-memory (not via a focus slot). Consumed by the first
  // runChatTurn call below, then cleared so later silent transitions in the same
  // message don't re-use it.
  let pendingEntryTarget: EntryTarget | undefined;
  // Set whenever renderWhatsNext reports the rung-0 profile gate is still open;
  // consumed by the very next runChatTurn call so Hank opens on the flagged gaps
  // rather than cold, then reset to undefined.
  let pendingProfileGaps: ProfileGaps | undefined;

  // 1. Widget submission. The user's message is a structured choice rather than
  // free text, so it commits deterministically — no LLM routing.
  const submission = yield* dispatchTopLevelSubmission({
    ...args,
    userMessage,
    attachmentIds,
  });
  if (submission.kind === "terminal") return;
  if (submission.kind !== "none") {
    // The submission WAS the message; whatever runs below is a silent
    // continuation of it.
    userMessage = "";
    attachmentIds = [];
  }
  if (submission.kind === "enter") {
    pendingEntryTarget = submission.entryTarget;
  }

  // The user hit send with an empty composer because their board marks are the
  // message. That's a real turn to answer, not the "nothing to run on" case
  // below — the marks become this turn's user row (see buildPanelEditBlocks).
  // Checked before anything settles them, and only when there's no text, since
  // that's the only case where it changes the routing.
  const carriesPanelEdits =
    submission.kind === "none" &&
    !userMessage &&
    (await listUnrelayedBoardEdits(args.userId)).length > 0;

  // 2. Nothing to run on — no text typed, nothing marked, no destination
  // picked. Ask what's next: either the rung-0 profile gate is still open (gaps
  // thread into the turn, which greets and elicits) or the picker renders and
  // stops.
  if (submission.kind !== "enter" && !userMessage && !carriesPanelEdits) {
    const r = yield* renderWhatsNext({
      ...args,
      narrateProfileSwitch: false,
    });
    if (r.kind === "rendered") return;
    pendingProfileGaps = r.gaps;
    yield* yieldUiEvents((await buildShowEvents(args.userId)).events);
  }

  // 3. Run chat turns until one returns wrappedUp=false (waiting on user input).
  // Each wrappedUp=true fires renderWhatsNext, which either reports the profile
  // gate is open (loop continues, Hank elicits) or renders the picker and stops
  // the loop.
  for (let i = 0; i < MAX_SILENT_TRANSITIONS; i++) {
    // Consume the picker's entry target on the first turn only; later silent
    // transitions in this loop derive their own state.
    const iterEntryTarget = pendingEntryTarget;
    pendingEntryTarget = undefined;
    let wrappedUp = false;
    // Set when this turn ended a company. The segment wrap runs HERE, once,
    // rather than inside each bundled mutation — see
    // procedures/registry/wrapSegment.ts for why.
    let endedCompanyId: string | undefined;
    let stopped = false;
    // eslint-disable-next-line no-await-in-loop -- streaming a turn's events as they happen — the point is to relay each one before the next
    for await (const ev of runChatTurn({
      ...args,
      userMessage,
      attachmentIds,
      // Only the FIRST pass carries them: by the time a silent transition comes
      // round again the blocks are written and settled.
      carriesPanelEdits: carriesPanelEdits && i === 0,
      profileGaps: pendingProfileGaps,
      entryTarget: iterEntryTarget,
    })) {
      if (ev.type === "done") {
        wrappedUp = ev.wrappedUp;
        endedCompanyId = ev.endedCompanyId;
      } else {
        if (ev.type === "stopped") stopped = true;
        yield ev;
      }
    }
    // One-shot: gaps belong only to the turn just triggered.
    pendingProfileGaps = undefined;
    if (stopped) return;
    // A company ended this pass: consolidate memory, compact the transcript, and
    // drop the right panel back to the dashboard. Runs after the reply is on
    // screen (it's slow and the user has nothing to wait for), and exactly once
    // no matter how many companies were closed.
    if (endedCompanyId) {
      // Panel FIRST: it's showing the company that just ended, and the wrap
      // below takes seconds (two LLM passes). Dropping it back to the dashboard
      // after would leave a closed company on screen for the whole wait.
      // eslint-disable-next-line no-await-in-loop -- a silent transition only exists because the previous turn wrapped
      yield* yieldUiEvents((await buildShowEvents(args.userId)).events);
      // eslint-disable-next-line no-await-in-loop -- the wrap reads the state the turn above it just wrote
      await runWrapSegment({ ...args, subject: "company" });
    }
    if (!wrappedUp) return;
    // Wrapped — a company segment closed, an application finished, or profile
    // intake completed. Render the picker widget and stop the loop; the user
    // picks, and their submission re-enters as a new message. The one case that
    // keeps the loop going is the profile gate still being open — we narrate
    // that switch (a brief "grabbing a couple details" cue) because the user
    // just wrapped something else and we owe them a transition cue.
    const r = yield* renderWhatsNext({
      ...args,
      narrateProfileSwitch: true,
    });
    if (r.kind === "rendered") return;
    pendingProfileGaps = r.gaps;
    // eslint-disable-next-line no-await-in-loop -- same: this pass is a continuation of the one before it
    yield* yieldUiEvents((await buildShowEvents(args.userId)).events);
    // Silent re-entry — no new user message.
    userMessage = "";
    attachmentIds = [];
  }
}
