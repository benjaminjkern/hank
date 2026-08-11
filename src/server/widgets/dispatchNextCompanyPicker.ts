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
//   - "add_companies" → back to the dashboard with a conversational opener
//     ("what are you looking for?"). Hank grows the watchlist via
//     find_companies / create_companies.
//
// Returns the narration text the caller emits + persists as a `pipeline_status`
// block, plus the entity the runner should dispatch on. It writes no session
// state: focus is ephemeral, so the entryTarget IS the handoff.

import { CompanyStatus, JobInteractionStatus } from "@/generated/prisma/client";
import { formatFocusRefToken } from "@/lib/focusRefToken";
import type { EntryTarget } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { companyStatusFields } from "@/server/entities/companies/companyStatusFields";

import type { NextCompanyPickerSubmission } from "./parse";

type NextCompanyPickerDispatchResult = {
  // Narration line to surface in chat. Caller emits as a `pipeline_status`
  // event AND persists as a `pipeline_status` content block on a new
  // assistant ChatMessage so it survives refresh.
  statusText: string;
  // The entity the ensuing silent-entry runner should dispatch on — threaded
  // in-memory as the runner's entryTarget (there's no focus slot to read).
  // Undefined for add_companies (conversational, nothing to run) and for a
  // race/stale row, where the runner falls through to "what's next".
  entryTarget?: EntryTarget;
};

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
        statusText:
          "That opportunity isn't available anymore — let me re-check.",
      };
    }
    return {
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
      statusText,
      entryTarget: { kind: "job", id: submission.jobId },
    };
  }

  // add_companies — no entity to dispatch on, just a conversational opener. Hank
  // grows the watchlist with find_companies (user describes what they want) or
  // create_companies (user named them).
  return {
    statusText:
      "Let's add some companies. What kind are you looking for? Or name a few and I'll pull them in.",
  };
}
