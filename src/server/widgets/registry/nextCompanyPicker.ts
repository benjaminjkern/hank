// The between-things chooser's answer. Per pick:
//   - "company" → bump NEW/PAUSED → READY (a PAUSED pick is a revive), then walk
//     it. Picking is not itself progress, so it writes the walkable state and
//     lets the walkthrough own every status after it.
//   - "opportunity" → put the lead on screen.
//   - "job" → a DEFERRED pick revives to SHORTLISTED, then work the role.
//   - "add_companies" → Hank asks what they're after; he grows the watchlist via
//     find_companies / create_companies once they say.
//
// Typed equivalents: company_walkthrough, work_on_job, find_companies.

import { sayUiEvents, statusEvent } from "@/server/contracts";
import type { Entry, StepArgs, StepOutcome } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { companyStatusFields } from "@/server/entities/companies/companyStatusFields";
import {
  CompanyStatus,
  JobInteractionStatus,
} from "@/server/generated/prisma/client";
import { buildShowEvents, showTargetFor } from "@/server/views/showEvents";
import { formatFocusRefToken } from "@/shared/focusRefToken";

import {
  parseNextCompanyPickerSubmission,
  type NextCompanyPickerSubmission,
} from "../parse";

import type { WidgetAnswerDef } from "./types";

// Asking beats guessing here: a search run off the profile alone comes back
// adjacent to what they already track, and correcting it costs a whole round.
const ADD_COMPANIES_NUDGE =
  "(They want to add companies to their watchlist but haven't said what kind. Ask what they're after — sector, stage, the shape of the role — or whether they already have names in mind. Don't search yet.)";

export const nextCompanyPickerAnswer: WidgetAnswerDef<NextCompanyPickerSubmission> =
  {
    parse: parseNextCompanyPickerSubmission,
    answer: async (submission, args) => {
      const pick = await resolvePick(args.userId, submission);
      if (pick.kind === "ask") return { next: pick.next };
      // Say where we're going and open the panel on it before the entry runs —
      // the walkthrough it enters can take a while to say anything itself.
      await args.say(statusEvent(pick.statusText));
      await sayUiEvents(
        args.say,
        (await buildShowEvents(args.userId, showTargetFor(pick.next))).events,
      );
      // A pick whose row vanished between render and click re-renders the
      // chooser against current data.
      return { next: pick.next ?? { kind: "show_whats_next" } };
    },
  };

// A pick either names somewhere to GO (with the line that announces it) or opens
// a conversation. A missing `next` on a "go" is a stale row.
type Pick =
  | { kind: "go"; statusText: string; next?: Entry }
  | { kind: "ask"; next: Entry };

async function resolvePick(
  userId: string,
  submission: NextCompanyPickerSubmission,
): Promise<Pick> {
  if (submission.choice === "company") {
    const ci = await prisma.companyInteraction.findUnique({
      where: {
        userId_companyId: { userId, companyId: submission.companyId },
      },
      select: { status: true, company: { select: { name: true } } },
    });
    if (!ci) {
      // Race: the company was deleted between render and submit.
      return {
        kind: "go",
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
      kind: "go",
      statusText: `Picking up ${formatFocusRefToken("company", submission.companyId, ci.company.name)}.`,
      next: { kind: "company_walkthrough", companyId: submission.companyId },
    };
  }

  if (submission.choice === "opportunity") {
    const opp = await prisma.opportunity.findUnique({
      where: { id: submission.opportunityId },
      select: { label: true, userId: true },
    });
    if (!opp || opp.userId !== userId) {
      return {
        kind: "go",
        statusText:
          "That opportunity isn't available anymore — let me re-check.",
      };
    }
    return {
      kind: "go",
      statusText: `Picking up ${formatFocusRefToken("opportunity", submission.opportunityId, opp.label)}.`,
      next: { kind: "opportunity", opportunityId: submission.opportunityId },
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
        kind: "go",
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
      kind: "go",
      statusText,
      next: { kind: "work_on_job", jobId: submission.jobId },
    };
  }

  // add_companies — nothing to dispatch on. Hank opens instead of a canned
  // line, because the useful question here depends on what they've been looking
  // at ("more early-stage infra like last time?"), which a fixed string can't ask.
  return { kind: "ask", next: { kind: "hank", nudge: ADD_COMPANIES_NUDGE } };
}
