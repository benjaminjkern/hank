// What one user message MEANS — the whole product sequence, from the moment the
// run is open to the moment the stream has nothing left to say.
//
//   1. Own the user's message (written before anything that can fail).
//   2. Decide its first step: a click it carries (a widget answer / panel
//      commit) runs deterministically; anything typed goes to Hank; an empty
//      send brings up what's next.
//   3. Run steps. Each one ends by naming what runs next (`next`) or by leaving
//      the user something to answer — and the loop stops there. Nothing runs
//      that a step, a click, or one of Hank's handoffs didn't name.
//   4. After the last step, file away any stretch of work that ended, or one that
//      just got long.
//
// The run itself — the concurrency claim, the AbortController, the runId, and
// what a thrown run MEANS — belongs to runtime/runUserMessage.ts, which wraps
// this. That file is true of any message regardless of what it says; every
// branch below is a decision about companies, roles, and profiles.

import { statusEvent } from "@/server/contracts";
import type { Segment, StepArgs, StepOutcome } from "@/server/contracts";
import { flipDueInterviewsToDebrief } from "@/server/entities/jobs/flipDueInterviews";
import { procedure } from "@/server/procedures/lib/procedure";
import { transcriptSizeSinceSummary } from "@/server/procedures/registry/compactSession";
import { runWrapSegment } from "@/server/procedures/registry/wrapSegment";
import { answerWidget } from "@/server/widgets/answerWidget";
import { nowMs } from "@/shared/utils/now";

import { openUserTurn } from "./openUserTurn";
import { runEntry } from "./runEntry";

// A runaway hand-off cycle can't loop forever within one message.
const MAX_STEPS = 8;

// Don't START a step with less than this left before the run's deadline — a
// walkthrough that begins with seconds to spare is the one the cap rips mid-write.
// The step that's already running reads `deadlineAt` itself and bails resumably.
const MIN_STEP_BUDGET_MS = 60_000;

// Transcript since the last summary, in characters of stored message JSON, past
// which the message ends with a wrap-up even though nothing ended — a long
// free-chat stretch, or one huge walkthrough, would otherwise never compact.
// Roughly 75k tokens: room for the system prompt inside the model's window.
const LONG_STRETCH_CHARS = 300_000;

export type ChatArgs = StepArgs & {
  userMessage: string;
  attachmentIds: string[];
  // The right panel's URL path when the user sent this (shared/panelUrl.ts).
  panelPath?: string;
};

export const runChat = procedure(
  "chat",
  async (args: ChatArgs): Promise<void> => {
    const { userMessage, attachmentIds, panelPath, ...step } = args;

    // 1. The user's message, before any work that can fail. Anything that throws
    // from here on still leaves what they said in the transcript, next to the
    // `run_error` row the failure writes — see openUserTurn for why that ordering
    // is load-bearing rather than tidy.
    const opened = await openUserTurn({ ...step, userMessage, attachmentIds });

    // Promote any INTERVIEW_SCHEDULED whose interview date has passed to
    // INTERVIEW_DEBRIEF before anything reads statuses, so "user owes a debrief"
    // surfaces on THIS message. Best-effort + idempotent.
    await flipDueInterviewsToDebrief();

    // 2. The first step. The marks a user sends with an empty composer ARE a
    // message (openUserTurn wrote them as the user row), so Hank answers it.
    let outcome: StepOutcome = (await answerWidget({
      ...step,
      userMessage,
    })) ?? {
      next:
        userMessage || opened.carriedPanelEdits
          ? { kind: "hank" }
          : { kind: "show_whats_next" },
    };

    // 3. Run what each step names.
    const ended = new Set<Segment>();
    let stepsRun = 0;
    // Sequential by nature: every step only exists because the one before it
    // named it, and reads the state that step wrote.
    /* eslint-disable no-await-in-loop */
    while (true) {
      if (outcome.ended) ended.add(outcome.ended);
      if (outcome.stopped) return;
      const next = outcome.next;
      if (!next || stepsRun >= MAX_STEPS) break;
      if (outOfTime(step.deadlineAt)) {
        await step.say(
          statusEvent(
            "That took a while — say the word and I'll keep going from here.",
          ),
        );
        break;
      }
      outcome = await runEntry(next, {
        ...step,
        afterOtherWork: stepsRun > 0,
        panelPath,
      });
      stepsRun++;
    }
    /* eslint-enable no-await-in-loop */

    // 4. File away what this message finished — after everything it said is on
    // screen, because it's slow (two LLM passes) and the user has nothing to wait
    // for. Once per message, however many companies ended. Say what the wait is,
    // in the user's language (never the mechanism: no "notes", no "summary").
    const subject = wrapSubject(ended);
    if (subject) {
      await step.say(
        statusEvent(
          subject === "discovery"
            ? "Filing away what I learned from that round…"
            : "Filing away what I learned from that stretch…",
        ),
      );
      await runWrapSegment({ ...step, subject });
    } else if (
      (await transcriptSizeSinceSummary(step.sessionId)) > LONG_STRETCH_CHARS
    ) {
      await step.say(statusEvent("Tidying up my notes on all that…"));
      await runWrapSegment({ ...step, subject: "long_stretch" });
    }
  },
);

function outOfTime(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && deadlineAt - nowMs() < MIN_STEP_BUDGET_MS;
}

// A company ending outranks a discovery round when both happened — the relay to
// Hank names one boundary, and the company is the bigger one.
function wrapSubject(ended: Set<Segment>): Segment | undefined {
  if (ended.has("company")) return "company";
  if (ended.has("discovery")) return "discovery";
  return undefined;
}
