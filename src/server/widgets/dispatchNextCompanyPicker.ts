// next_company_picker dispatch. This widget renders between things, so the
// dispatch lives at the chat-entry level (dispatchTopLevelSubmission dispatches it
// deterministically before the runner is invoked). The parser lives in ./parse.
//
// Per kind:
//   - "company" → show the company + bump NEW/PAUSED → READY (a PAUSED pick is a
//     revive). Picking is not itself progress, so it writes the walkable state
//     and lets the walkthrough own every status after it.
//   - "opportunity" → show the opportunity.
//   - "job" → show the role; a DEFERRED pick revives to SHORTLISTED.
//   - "add_companies" → hands the turn to Hank to ask what they're after. He
//     grows the watchlist via find_companies / create_companies once they say.
//
// It writes no session state: focus is ephemeral, so the entryTarget IS the
// handoff.

import { CompanyStatus, JobInteractionStatus } from "@/generated/prisma/client";
import { formatFocusRefToken } from "@/lib/focusRefToken";
import type { EntryTarget } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { companyStatusFields } from "@/server/entities/companies/companyStatusFields";

import type { NextCompanyPickerSubmission } from "./parse";

// Asking beats guessing here: a search run off the profile alone comes back
// adjacent to what they already track, and correcting it costs a whole round.
const ADD_COMPANIES_NUDGE =
  "(They want to add companies to their watchlist but haven't said what kind. Ask what they're after — sector, stage, the shape of the role — or whether they already have names in mind. Don't search yet.)";

// A pick either names somewhere to GO or opens a conversation, and the two need
// different things from the caller — so they're separate variants rather than
// one shape with an optional target. A missing target on an "enter" is a stale
// row: the runner falls through to "what's next", which re-renders the picker
// against current data. That fall-through is the right answer for a race and
// the wrong one for add-companies, which is why the latter is its own variant.
type NextCompanyPickerDispatchResult =
  | {
      kind: "enter";
      // Narration line to surface in chat. Caller emits as a `pipeline_status`
      // event AND persists as a `pipeline_status` content block on a new
      // assistant ChatMessage so it survives refresh.
      statusText: string;
      // The entity the ensuing silent-entry runner should dispatch on —
      // threaded in-memory as the runner's entryTarget (there's no focus slot
      // to read).
      entryTarget?: EntryTarget;
    }
  // Nothing to run and nothing worth canning: Hank opens the next turn on this
  // instruction. See ChatTurnRunner's openingNudge.
  | { kind: "ask"; openingNudge: string };

export async function dispatchNextCompanyPicker(args: {
  userId: string;
  sessionId: string;
  submission: NextCompanyPickerSubmission;
}): Promise<NextCompanyPickerDispatchResult> {
  const { userId, submission } = args;

  if (submission.choice === "company") {
    const ci = await prisma.companyInteraction.findUnique({
      where: {
        userId_companyId: { userId, companyId: submission.companyId },
      },
      select: { status: true, company: { select: { name: true } } },
    });
    if (!ci) {
      // Race: the company was deleted between render and submit. Returning no
      // entryTarget falls the runner through to "what's next", which re-renders.
      return {
        kind: "enter",
        statusText: "That company isn't available anymore — let me re-check.",
      };
    }
    // NEW/PAUSED → READY. A PAUSED pick is a revive (the picker surfaces paused
    // companies as their own section) — routing through companyStatusFields
    // clears the pause fields in the same write, so the row doesn't resurface as
    // paused. Every other status is left alone: picking a company is the user
    // saying where to look, not progress through it, so it must not knock a
    // SHORTLISTING or APPLYING row back to the start of the ladder.
    if (ci.status === CompanyStatus.NEW || ci.status === CompanyStatus.PAUSED) {
      await prisma.companyInteraction.update({
        where: {
          userId_companyId: { userId, companyId: submission.companyId },
        },
        data: companyStatusFields({ status: CompanyStatus.READY }),
      });
    }
    return {
      kind: "enter",
      statusText: `Picking up ${formatFocusRefToken("company", submission.companyId, ci.company.name)}.`,
      entryTarget: { kind: "company", id: submission.companyId },
    };
  }

  if (submission.choice === "opportunity") {
    const opp = await prisma.opportunity.findUnique({
      where: { id: submission.opportunityId },
      select: { label: true, userId: true },
    });
    if (!opp || opp.userId !== userId) {
      return {
        kind: "enter",
        statusText:
          "That opportunity isn't available anymore — let me re-check.",
      };
    }
    return {
      kind: "enter",
      statusText: `Picking up ${formatFocusRefToken("opportunity", submission.opportunityId, opp.label)}.`,
      entryTarget: { kind: "opportunity", id: submission.opportunityId },
    };
  }

  if (submission.choice === "job") {
    const ji = await prisma.jobInteraction.findUnique({
      where: { userId_jobId: { userId, jobId: submission.jobId } },
      select: {
        status: true,
        job: {
          select: {
            title: true,
            companyName: true,
            company: { select: { name: true } },
          },
        },
      },
    });
    if (!ji) {
      // Race: the job/JobInteraction vanished between render and submit.
      return {
        kind: "enter",
        statusText: "That role isn't available anymore — let me re-check.",
      };
    }

    // A picked job-level deferral that has come due is a revive: clear the
    // defer fields and re-activate it as SHORTLISTED (pursuing) so it doesn't
    // re-strand as paused. Owed jobs (INTERVIEW_DEBRIEF / OFFERED) keep their
    // status — the debrief / offer conversation is the point, not a transition.
    if (ji.status === JobInteractionStatus.DEFERRED) {
      await prisma.jobInteraction.update({
        where: { userId_jobId: { userId, jobId: submission.jobId } },
        data: {
          status: JobInteractionStatus.SHORTLISTED,
          deferReason: null,
          deferNote: null,
        },
      });
    }

    // The opener below is the user-facing cue; Hank runs the debrief / offer /
    // un-pause conversation from the user's reply next turn.
    const where = ji.job.company?.name ?? ji.job.companyName;
    const at = where ? ` at ${where}` : "";
    const roleChip = formatFocusRefToken("job", submission.jobId, ji.job.title);
    const statusText =
      ji.status === JobInteractionStatus.INTERVIEW_DEBRIEF
        ? `Let's debrief your ${roleChip} interview${at} — how did it go?`
        : ji.status === JobInteractionStatus.OFFERED
          ? `Let's talk through your offer for ${roleChip}${at}.`
          : ji.status === JobInteractionStatus.WAITING_ON_RESPONSE
            ? `It's been quiet on ${roleChip}${at} since the interview — want to follow up with them?`
            : `Picking ${roleChip}${at} back up.`;
    return {
      kind: "enter",
      statusText,
      entryTarget: { kind: "job", id: submission.jobId },
    };
  }

  // add_companies — nothing to dispatch on. Hank opens instead of a canned
  // line, because the useful question here depends on what they've been looking
  // at ("more early-stage infra like last time?"), which a fixed string can't ask.
  return {
    kind: "ask",
    openingNudge: ADD_COMPANIES_NUDGE,
  };
}
