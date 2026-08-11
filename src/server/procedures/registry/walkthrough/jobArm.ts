// The job arm (steps 4-6): fetch the application form, draft the cover letter +
// short answers, then wait for the user to submit.
//
// Focus is ephemeral, so there's no sticky co-write / paused-drafting marker:
// re-entering a job just re-runs the draft procedure, which re-derives what's
// already drafted and which ask_user items remain from JobInteraction.draftDecision.
// Resume is automatic and idempotent — nothing to check.

import { JobInteractionStatus } from "@/generated/prisma/client";
import { statusEvent, yieldUiEvents } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { WORKABLE_STATUSES } from "@/server/entities/jobs/jobInteractionInputs";
import { runDraftApplication } from "@/server/procedures/registry/draftApplication";
import {
  buildApplicationEvents,
  buildShowEvents,
} from "@/server/views/showEvents";

import { runCompanyArm } from "./companyArm";
import { narrateApplicationReady } from "./narration";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

export async function* runJobArm(
  jobId: string,
  args: WalkthroughArgs,
  // freshEntry = the user deliberately entered this job THIS turn (picked it
  // from the next-job picker, or said "resume drafting"), as opposed to an
  // incidental re-dispatch after a free-text chat. Drives the Step 6 terminal
  // narration so a deliberately-entered job that needs no work still gets a
  // status instead of going silent.
  opts: { freshEntry?: boolean } = {},
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  // Defensive: if the dispatched job is no longer live work (the user skipped /
  // deferred / applied since it was picked), self-correct — re-dispatch via the
  // company arm, which picks the next one. Prevents the state machine from
  // sitting on a terminal job and doing nothing every subsequent turn.
  // A row already mid-draft (APPLYING) is live: re-entering it resumes.
  const ji = await prisma.jobInteraction.findFirst({
    where: { userId: args.userId, jobId },
    select: {
      status: true,
      job: { select: { companyId: true } },
    },
  });
  if (!ji || !WORKABLE_STATUSES.includes(ji.status)) {
    yield statusEvent(
      "That job is no longer shortlisted — going back to the company.",
    );
    // Focus is ephemeral — nothing to clear; re-dispatch to the company arm
    // (which surfaces the next-role picker) and show the company page.
    if (ji?.job.companyId) {
      yield* yieldUiEvents(
        (await buildShowEvents(args.userId, { companyId: ji.job.companyId }))
          .events,
      );
      return yield* runCompanyArm(ji.job.companyId, args);
    }
    return { wrappedUp: true };
  }

  // Steps 4–5.25: fetch the form, decide, draft, and run the critique/revise
  // loop — the draft-application procedure. It yields the progress events and
  // returns what the shell needs to decide the co-write hand-off (Step 5.5) and
  // the terminal narration (Step 6).
  const outcome = yield* runDraftApplication({ ...args, jobId });

  // Step 5.5: hand off to chat co-writing for any item that needs the user's own
  // input. Emits the opening once, then waits. No marker (focus is ephemeral) —
  // the user's replies drive it and re-entering the job re-derives what's still
  // pending, so resume is automatic.
  //
  // Whatever WAS drafted goes on screen first. The two halves are one pass —
  // "here's what I wrote, and here's what I couldn't" — and leading with the
  // ask alone read as though nothing had been written at all.
  if (outcome.askUserItems.length > 0) {
    const drafted = outcome.hasCoverLetter || outcome.answersCount > 0;
    if (drafted) {
      yield* yieldUiEvents(
        (await buildApplicationEvents(args.userId, jobId)).events,
      );
    }
    return yield* enterCoWrite(
      outcome.companyDisplay,
      outcome.askUserItems,
      drafted,
    );
  }

  // Step 6: wait for submit. Narrate when work happened this pass OR when the
  // user deliberately entered this job this turn (freshEntry — picked it from
  // the next-job picker / said "resume"). A deliberately-entered job that needs
  // no work — form already fetched, an unsupported form we can't read, or
  // everything already drafted — still owes the user a status instead of the
  // silent stop (they picked it and saw only "Working on <role>."). Incidental
  // re-dispatches after a free-text chat that touched no state (didWork=false,
  // not a fresh entry) stay quiet so we don't repeat the terminal line every
  // turn.
  if (outcome.didWork || opts.freshEntry) {
    if (
      outcome.formUnavailable &&
      !outcome.hasCoverLetter &&
      outcome.answersCount === 0
    ) {
      // Capability not available — explain plainly, offer the manual path, and
      // let them move on. If they paste any cover-letter / short-answer fields,
      // the free-text walkthrough path lets Hank draft + save them.
      yield {
        type: "text",
        text:
          "Looks like I can't get to the application form for this one on my own. " +
          "If you open the posting and let me know about any cover letter or short-answer questions, " +
          "I'll draft them for you — otherwise no worries, just tap **I submitted ✓** once you've applied.",
      };
    } else if (!outcome.hasCoverLetter && outcome.answersCount === 0) {
      // The decider ran but everything came back skip — no cover letter, nothing
      // substantive to draft, and nothing that needed the user's own input
      // (ask_user items would have handed off to co-write above and returned).
      // Don't claim "draft ready in the right panel" when no draft exists (the
      // silent-move-on bug) — say plainly there's nothing here worth drafting.
      yield {
        type: "text",
        text:
          "I went through this application and there's nothing here I'd draft for you — " +
          "it's the kind of form you fill in directly (basic details, dropdowns, links). " +
          "Tap **I submitted ✓** once you've applied.",
      };
    } else {
      // Put the application on screen rather than telling them where to look,
      // then hand over what the reviewer actually said about it.
      yield* yieldUiEvents(
        (await buildApplicationEvents(args.userId, jobId)).events,
      );
      yield {
        type: "text",
        text: narrateApplicationReady({
          note: outcome.note,
          openFindings: (outcome.review?.open ?? []).map(
            (f) => `**${f.label}** — ${f.note}`,
          ),
        }),
      };
    }
  }
  return { wrappedUp: false };
}

// Enter chat co-writing: emit the opening once and wait. Focus is ephemeral, so
// there's no marker — the user's replies drive it (Hank saves each via
// save_application_answer with the job's slug), and re-entering the job
// (work_on_job / the next_job_picker) re-runs the draft procedure, which
// re-derives what's still pending from draftDecision and re-emits the opening for
// the remainder until everything's answered.
async function* enterCoWrite(
  companyName: string,
  items: string[],
  drafted: boolean,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  const list = items.map((i) => `- ${i}`).join("\n");
  const lead = drafted
    ? `I've written what I could for ${companyName} — it's on the right. `
    : "";
  const intro =
    items.length === 1
      ? `${lead}There's one thing I'd rather not draft until you tell me more, because I'd be guessing:`
      : `${lead}There are a few things I'd rather not draft until you tell me more, because I'd be guessing:`;
  const closer =
    items.length === 1
      ? `Tell me a bit about it and I'll shape it into a strong answer with you.`
      : `Tell me about the first and I'll shape it into a strong answer — we'll work through them together.`;
  yield { type: "text", text: `${intro}\n\n${list}\n\n${closer}` };
  return { wrappedUp: false };
}
